import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const { createAuditLog, verifyAuditLog, AUDIT_GENESIS, createAuditRouter } = await import(
  '../src/audit.js'
)

describe('log de auditoria — append-only com cadeia de hash', () => {
  /** @type {string} */ let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autopsy-audit-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('grava NDJSON com um registro por evento, com seq/UTC/hash', () => {
    const logPath = join(dir, 'audit.ndjson')
    const log = createAuditLog({ path: logPath, session: 's1' })
    log.record({ tool: 'list_cases', case: { label: 'Caso X' }, args: {}, ok: true })
    log.record({ tool: 'get_case_summary', args: { limit: 1 }, ok: true })

    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    expect(lines.length).toBe(2)
    const first = JSON.parse(lines[0])
    expect(first.tool).toBe('list_cases')
    expect(first.session).toBe('s1')
    expect(first.seq).toBe(1)
    expect(first.ts_utc).toMatch(/Z$/)
    expect(first.prev).toBe(AUDIT_GENESIS)
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(lines[1]).prev).toBe(first.hash)
  })

  test('verifyAuditLog confirma cadeia íntegra', () => {
    const logPath = join(dir, 'audit.ndjson')
    const log = createAuditLog({ path: logPath })
    for (let i = 0; i < 3; i++) log.record({ tool: `t${i}`, ok: true })
    const v = verifyAuditLog(logPath)
    expect(v.ok).toBe(true)
    expect(v.count).toBe(3)
    expect(v.last_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('adulterar uma linha quebra a cadeia e aponta o seq', () => {
    const logPath = join(dir, 'audit.ndjson')
    const log = createAuditLog({ path: logPath })
    for (let i = 0; i < 3; i++) log.record({ tool: `t${i}`, ok: true })
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    const alvo = JSON.parse(lines[1])
    alvo.tool = 'ADULTERADO'
    lines[1] = JSON.stringify(alvo)
    writeFileSync(logPath, lines.join('\n') + '\n')

    const v = verifyAuditLog(logPath)
    expect(v.ok).toBe(false)
    expect(v.broken_at).toBe(2)
  })

  test('remover uma linha também quebra a cadeia', () => {
    const logPath = join(dir, 'audit.ndjson')
    const log = createAuditLog({ path: logPath })
    for (let i = 0; i < 4; i++) log.record({ tool: `t${i}`, ok: true })
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    lines.splice(1, 1)
    writeFileSync(logPath, lines.join('\n') + '\n')
    expect(verifyAuditLog(logPath).ok).toBe(false)
  })

  test('recusa log dentro do case (cadeia de custódia)', () => {
    const caseDir = join(dir, 'caso')
    mkdirSync(caseDir, { recursive: true })
    expect(() =>
      createAuditLog({ path: join(caseDir, 'audit.ndjson'), caseDirOf: () => caseDir })
    ).toThrow(/cadeia de custódia/i)
  })

  test('continua a cadeia de um log existente (seq e prev corretos)', () => {
    const logPath = join(dir, 'audit.ndjson')
    const a = createAuditLog({ path: logPath })
    a.record({ tool: 'primeiro', ok: true })
    const b = createAuditLog({ path: logPath })
    b.record({ tool: 'segundo', ok: true })
    const v = verifyAuditLog(logPath)
    expect(v.ok).toBe(true)
    expect(v.count).toBe(2)
    expect(JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n')[1]).seq).toBe(2)
  })

  test('log existente corrompido interrompe (fail-closed) em vez de reiniciar', () => {
    const logPath = join(dir, 'audit.ndjson')
    writeFileSync(logPath, 'isto nao e json\n')
    expect(() => createAuditLog({ path: logPath })).toThrow(/corrompido|inválido/i)
  })
})

describe('trilha rotativa por caso (modo diretório)', () => {
  /** @type {string} */ let dir
  /** @type {{ label: string|null, caseDir: string|null, dbPath: string|null }} */ let state
  /** @type {ReturnType<Awaited<typeof import('../src/audit.js')>['createAuditRouter']>} */ let router

  const cria = async () => {
    const { createAuditRouter } = await import('../src/audit.js')
    state = { label: null, caseDir: null, dbPath: null }
    router = createAuditRouter({ target: dir, caseOf: () => state })
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'autopsy-rot-'))
    await cria()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('antes do case vai para o arquivo de sessão; depois, para o arquivo do caso', () => {
    router.record({ tool: 'list_cases', ok: true })
    const sessao = readdirSync(dir).find(f => /^audit-_session-[0-9a-f]{8}\.ndjson$/.test(f))
    expect(sessao).toBeTruthy()

    state.label = 'Caso-Teste'
    state.caseDir = join(dir, 'Caso-Teste')
    state.dbPath = join(dir, 'Caso-Teste', 'autopsy.db')
    router.record({ tool: 'set_active_case', ok: true })

    const doCaso = readdirSync(dir).filter(f => f.startsWith('audit-Caso-Teste'))
    expect(doCaso.length).toBe(1)
    expect(
      readFileSync(join(dir, sessao ?? ''), 'utf8')
        .trim()
        .split('\n').length
    ).toBe(1)
    expect(readFileSync(join(dir, doCaso[0]), 'utf8').trim().split('\n').length).toBe(1)
    expect(router.currentPath()).toContain('Caso-Teste')
  })

  test('sessões diferentes no mesmo caso continuam a mesma cadeia (sem duplicar arquivo)', async () => {
    state.label = 'Caso-Teste'
    state.caseDir = join(dir, 'Caso-Teste')
    state.dbPath = join(dir, 'Caso-Teste', 'autopsy.db')
    router.record({ tool: 'primeira', ok: true })
    const p1 = router.currentPath()

    await cria() // nova sessão no mesmo caso
    state.label = 'Caso-Teste'
    state.caseDir = join(dir, 'Caso-Teste')
    state.dbPath = join(dir, 'Caso-Teste', 'autopsy.db')
    router.record({ tool: 'segunda', ok: true })

    expect(router.currentPath()).toBe(p1)
    const v = verifyAuditLog(p1)
    expect(v.ok).toBe(true)
    expect(v.count).toBe(2)
  })

  test('rótulo com caracteres inválidos vira nome seguro e casos homônimos não colidem', () => {
    state.label = 'ACME / Caso "X" 2026'
    state.caseDir = join(dir, 'a')
    state.dbPath = join(dir, 'a', 'autopsy.db')
    router.record({ tool: 'a', ok: true })
    const p1 = router.currentPath()
    expect(basename(p1)).toMatch(/^audit-ACME_Caso_X_2026-[0-9a-f]{8}\.ndjson$/)

    state.caseDir = join(dir, 'b')
    state.dbPath = join(dir, 'b', 'autopsy.db')
    router.record({ tool: 'b', ok: true })
    expect(router.currentPath()).not.toBe(p1)
  })

  test('modo arquivo único continua valendo (compatibilidade)', () => {
    const single = join(dir, 'unico.ndjson')
    state = { label: null, caseDir: null, dbPath: null }
    const r = createAuditRouter({ target: single, caseOf: () => state })
    r.record({ tool: 'x', ok: true })
    state.label = 'Caso-Teste'
    r.record({ tool: 'y', ok: true })
    expect(r.currentPath()).toBe(single)
    expect(readFileSync(single, 'utf8').trim().split('\n').length).toBe(2)
  })
})

describe('detecção de modo do alvo de auditoria', () => {
  test('caminho inexistente sem extensão = diretório rotativo; com extensão = arquivo único', async () => {
    const { resolveAuditTarget } = await import('../src/audit.js')
    expect(resolveAuditTarget('/tmp/nao-existe-xyz/audit').mode).toBe('rotating')
    expect(resolveAuditTarget('/tmp/nao-existe-xyz/audit.ndjson').mode).toBe('single')
    expect(resolveAuditTarget('/tmp/nao-existe-xyz/audit/').mode).toBe('rotating')
    expect(resolveAuditTarget('/tmp/x/audit-{case}.ndjson').mode).toBe('rotating')
  })
})
