import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { makeCase } from './fixtures/make-case.js'

const { createMcpServer } = await import('../src/server.js')
const { createCtx } = await import('../src/ctx.js')

/**
 * conecta cliente MCP ao server do ctx informado
 * @param {import("../src/ctx.js").Ctx} ctx
 */
async function connect(ctx) {
  const server = createMcpServer(ctx)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'audit-test', version: '0.0.0' })
  await client.connect(clientSide)
  return client
}

describe('auditoria no server — toda chamada vira registro', () => {
  /** @type {string} */ let dir
  /** @type {string} */ let auditPath
  /** @type {import('../src/ctx.js').Ctx} */ let ctx
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coroner-'))
    const { caseDir } = makeCase(dir)
    auditPath = join(dir, 'audit.ndjson')
    ctx = createCtx({ casesDir: dir, exportDir: null, filesRoot: null, auditLog: auditPath })
    ctx.setActiveCase(caseDir)
  })

  test('chamadas MCP geram registros encadeados com case e resultado', async () => {
    const client = await connect(ctx)
    await client.callTool({ name: 'list_cases', arguments: {} })
    await client.callTool({ name: 'get_case_summary', arguments: {} })
    await client.close()

    const lines = readFileSync(auditPath, 'utf8').trim().split('\n')
    expect(lines.length).toBe(2)
    const recs = lines.map(l => JSON.parse(l))
    expect(recs[0].tool).toBe('list_cases')
    expect(recs[0].case.label).toBe('Caso-Teste')
    expect(recs[0].ok).toBe(true)
    expect(recs[0].result.cases_found).toBe(1)
    expect(recs[1].prev).toBe(recs[0].hash)
    expect(recs[1].result.total_files).toBe(4)
  })

  test('erro de tool também é registrado (ok=false com a mensagem)', async () => {
    const client = await connect(ctx)
    await client.callTool({ name: 'get_file_metadata', arguments: { objId: 987654 } })
    await client.close()
    const rec = JSON.parse(readFileSync(auditPath, 'utf8').trim())
    expect(rec.ok).toBe(false)
    expect(rec.error).toMatch(/obj_id/)
  })

  test('verify_audit_log comprova a integridade pela própria interface MCP', async () => {
    const client = await connect(ctx)
    await client.callTool({ name: 'get_case_summary', arguments: {} })
    const r = await client.callTool({ name: 'verify_audit_log', arguments: {} })
    const payload = JSON.parse(/** @type {any[]} */ (r.content).find(c => c.type === 'text').text)
    expect(payload.ok).toBe(true)
    expect(payload.algorithm).toBe('sha256')
    await client.close()
  })

  test('seal_audit_log sela a trilha (e o selo cobre o proprio ato)', async () => {
    const client = await connect(ctx)
    await client.callTool({ name: 'get_case_summary', arguments: {} })
    const out = join(dir, 'selo.json')
    const r = await client.callTool({ name: 'seal_audit_log', arguments: { outPath: out } })
    const seal = JSON.parse(/** @type {any[]} */ (r.content).find(c => c.type === 'text').text)
    expect(seal.chain.ok).toBe(true)
    // get_case_summary + o registro do proprio ato de selar = 2 registros cobertos
    expect(seal.chain.count).toBe(2)
    expect(seal.log.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(seal.generated_by).toMatch(/coroner/)
    await client.close()
    const { verifySeal } = await import('../src/seal.js')
    expect((await verifySeal(out)).ok).toBe(true)
  })

  test('log dentro do case é recusado na inicialização (fail-closed)', () => {
    const bad = createCtx({
      casesDir: dir,
      exportDir: null,
      filesRoot: null,
      auditLog: join(ctx.active.caseDir ?? dir, 'audit.ndjson'),
    })
    bad.setActiveCase(ctx.active.caseDir ?? dir)
    expect(() => createMcpServer(bad)).toThrow(/cadeia de custódia/i)
  })

  test('log que não pode ser gravado falha na inicialização (fail-closed)', () => {
    // caminho impossível: 'arquivo.txt' é arquivo, então não dá para criar a pasta
    writeFileSync(join(dir, 'arquivo.txt'), 'nao e diretorio')
    const bad = createCtx({
      casesDir: dir,
      exportDir: null,
      filesRoot: null,
      auditLog: join(dir, 'arquivo.txt', 'audit.ndjson'),
    })
    expect(() => createMcpServer(bad)).toThrow(/log de auditoria/i)
  })

  test('trilha rotativa: sessão e caso vão para arquivos separados, e verify aponta o do caso', async () => {
    const auditDir = join(dir, 'audit')
    const rot = createCtx({ casesDir: dir, exportDir: null, filesRoot: null, auditLog: auditDir })
    const client = await connect(rot)
    await client.callTool({ name: 'list_cases', arguments: {} })
    await client.callTool({
      name: 'set_active_case',
      arguments: { casePath: join(dir, 'Caso-Teste') },
    })
    const v = await client.callTool({ name: 'verify_audit_log', arguments: {} })
    const payload = JSON.parse(/** @type {any[]} */ (v.content).find(c => c.type === 'text').text)
    expect(payload.ok).toBe(true)
    expect(payload.path).toContain('audit-Caso-Teste-')
    // o registro do próprio verify entra DEPOIS da verificação (o resultado reflete o estado anterior)
    expect(payload.count).toBe(1)
    await client.close()
    const arquivos = readdirSync(auditDir)
    expect(arquivos.some(f => /^audit-_session-/.test(f))).toBe(true)
    expect(arquivos.some(f => /^audit-Caso-Teste-/.test(f))).toBe(true)
  })
})
