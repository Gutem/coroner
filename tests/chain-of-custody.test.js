import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCase } from './fixtures/make-case.js'

const tools = await import('../src/tools.js')
const { createCtx } = await import('../src/ctx.js')

describe('cadeia de custódia — invariância do autopsy.db', () => {
  /** @type {string} */ let dir
  /** @type {string} */ let dbPath
  /** @type {import('../src/ctx.js').Ctx} */ let ctx
  /** @type {string} */ let hashBefore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coroner-'))
    ;({ dbPath } = makeCase(dir))
    ctx = createCtx({ casesDir: dir, exportDir: null, filesRoot: null })
    ctx.setActiveCase(`${dir}/Caso-Teste`)
    hashBefore = createHash('sha256').update(readFileSync(dbPath)).digest('hex')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('rodar todas as tools não altera um byte do autopsy.db', () => {
    tools.getCaseSummary(ctx, {})
    tools.browseFilesystem(ctx, {})
    tools.browseFilesystem(ctx, { parentObjId: 10 })
    tools.queryBlackboardArtifacts(ctx, {})
    tools.queryBlackboardArtifacts(ctx, { artifactType: 'TSK_WEB_HISTORY' })
    tools.searchKeywords(ctx, { keyword: 'notes', scope: 'both' })
    tools.getFileMetadata(ctx, { objId: 11 })
    tools.browseTags(ctx, {})
    tools.browseTimeline(ctx, { start: 0, end: 9999999999, field: 'mtime' })
    tools.getOsAccounts(ctx, {})
    tools.searchKeywordHits(ctx, { keyword: 'bitcoin' })
    // erros também não podem escrever
    try {
      tools.queryBlackboardArtifacts(ctx, { artifactType: 'TSK_NADA' })
    } catch {
      /* esperado */
    }
    const hashAfter = createHash('sha256').update(readFileSync(dbPath)).digest('hex')
    expect(hashAfter).toBe(hashBefore)
  })
})
