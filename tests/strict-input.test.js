import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { makeCase } from './fixtures/make-case.js'

const { createMcpServer } = await import('../src/server.js')
const { createCtx } = await import('../src/ctx.js')

/**
 * Classe da issue sleuthkit/autopsy#8033: parâmetro desconhecido descartado em
 * silêncio → a tool roda como se nenhum filtro tivesse sido passado e o agente
 * recebe um resultado plausível e ERRADO. Em perícia isso é pior que um erro.
 */
describe('entrada estrita — parâmetro desconhecido nunca é ignorado em silêncio', () => {
  /** @type {string} */ let dir
  /** @type {string} */ let caseDirPath
  /** @type {Client} */ let client

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'coroner-strict-'))
    const { caseDir } = makeCase(dir)
    caseDirPath = caseDir
    const ctx = createCtx({ casesDir: dir, exportDir: null, filesRoot: null })
    ctx.setActiveCase(caseDir)
    const server = createMcpServer(ctx)
    const [c, s] = InMemoryTransport.createLinkedPair()
    await server.connect(c)
    client = new Client({ name: 'strict-client', version: '0.0.0' })
    await client.connect(s)
  })

  afterAll(async () => {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('o JSON Schema anunciado exige additionalProperties: false', async () => {
    const r = await client.listTools()
    /** @type {string[]} */
    const frouxos = []
    for (const t of r.tools) {
      const schema = /** @type {any} */ (t).inputSchema
      if (schema && (schema.type === 'object' || schema.properties)) {
        if (schema.additionalProperties !== false) frouxos.push(t.name)
      }
    }
    expect(frouxos).toEqual([])
  })

  test('chamar com parâmetro inventado falha, em vez de devolver resultado não filtrado', async () => {
    let desfecho = 'sucesso'
    try {
      const res = await client.callTool({
        name: 'browse_filesystem',
        arguments: { parametroInventado: 1 },
      })
      if (/** @type {any} */ (res).isError) desfecho = 'erro-explicito'
    } catch {
      desfecho = 'excecao'
    }
    expect(desfecho).not.toBe('sucesso')
  })

  test('erro nomeia o parâmetro desconhecido (o agente se autocorrige)', async () => {
    let texto = ''
    try {
      const res = await client.callTool({
        name: 'browse_filesystem',
        arguments: { parametroInventado: 1 },
      })
      texto = JSON.stringify(/** @type {any} */ (res).content ?? res)
    } catch (e) {
      texto = e instanceof Error ? e.message : String(e)
    }
    expect(texto).toMatch(/parametroInventado|Unrecognized key|unrecognized|inválid|invalid/i)
  })

  // Trade-off deliberado: o conversor do SDK só anuncia `additionalProperties: false`
  // para o objeto estrito NU — qualquer invólucro (.optional/.default/preprocess) perde o
  // flag (o preprocess perde tudo). Em troca, cliente que OMITE `arguments` recebe erro de
  // validação. O requisito de perícia é o outro lado: nunca sucesso silencioso.
  test('chamada sem a chave arguments falha explícita (nunca sucesso silencioso)', async () => {
    let desfecho = 'sucesso'
    try {
      const res = await client.callTool({ name: 'browse_filesystem' })
      if (/** @type {any} */ (res).isError) desfecho = 'erro-explicito'
    } catch {
      desfecho = 'excecao'
    }
    expect(desfecho).not.toBe('sucesso')
  })

  test('chamada válida continua funcionando', async () => {
    const res = await client.callTool({ name: 'browse_filesystem', arguments: {} })
    expect(/** @type {any} */ (res).isError).toBeFalsy()
  })

  test('schema aninhado de subcampo também não aceita chave inventada', async () => {
    let desfecho = 'sucesso'
    try {
      const res = await client.callTool({
        name: 'set_active_case',
        arguments: { casePath: caseDirPath, chaveInvenTada: true },
      })
      if (/** @type {any} */ (res).isError) desfecho = 'erro-explicito'
    } catch {
      desfecho = 'excecao'
    }
    expect(desfecho).not.toBe('sucesso')
  })
})
