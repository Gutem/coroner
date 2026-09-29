import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCase } from './fixtures/make-case.js'

const tools = await import('../src/tools.js')
const { createCtx } = await import('../src/ctx.js')

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'coroner-'))
  const { caseDir, dbPath } = makeCase(dir)
  const ctx = createCtx({ casesDir: dir, exportDir: null, filesRoot: null })
  ctx.setActiveCase(caseDir)
  return { dir, caseDir, dbPath, ctx }
}

describe('tools — caso ativo e navegação', () => {
  /** @type {{ dir: string, caseDir: string, dbPath: string, ctx: import('../src/ctx.js').Ctx }} */
  let s
  beforeEach(() => (s = setup()))
  afterEach(() => rmSync(s.dir, { recursive: true, force: true }))

  test('list_cases encontra o caso pela presença de autopsy.db', () => {
    const r = tools.listCases(s.ctx, {})
    expect(r.cases_found).toBe(1)
    expect(r.cases[0].case_name).toBe('Caso-Teste')
    expect(r.cases[0].case_dir).toBe(s.caseDir)
  })

  test('case_name funciona com path Windows e POSIX (regressão)', () => {
    expect(tools.caseNameFromDbPath('C:\\Cases\\Caso-Teste\\autopsy.db')).toBe('Caso-Teste')
    expect(tools.caseNameFromDbPath('/home/analista/Caso-Teste/autopsy.db')).toBe('Caso-Teste')
  })

  test('set_active_case valida e retorna schema_version', () => {
    const ctx2 = createCtx({ casesDir: s.dir, exportDir: null, filesRoot: null })
    const r = tools.setActiveCase(ctx2, { casePath: s.caseDir })
    expect(r.status).toBe('ok')
    expect(r.schema_version).toBe(800)
    expect(r.mode).toMatch(/READ-ONLY/i)
  })

  test('get_case_summary retorna data sources, contagens e breakdown', () => {
    const r = tools.getCaseSummary(s.ctx, {})
    expect(r.total_files).toBe(4)
    expect(r.total_artifacts).toBe(5)
    expect(r.data_sources[0].name).toBe('img_disk.E01')
    expect(
      r.artifact_breakdown.some(/** @param {any} a */ a => a.type_name === 'TSK_WEB_HISTORY')
    ).toBe(true)
    // regressão: as chaves do tsk_db_info_extended vêm em CamelCase e nunca casavam
    expect(r.case_name).toBe('Caso-Teste')
    expect(r.examiner).toBe('Fulano')
    expect(r.case_metadata_available).toBe(true)
    expect(r.metadata_note).toBeUndefined()
  })

  test('browse_filesystem sem args lista as raízes (data sources)', () => {
    const r = tools.browseFilesystem(s.ctx, {})
    expect(r.entries.length).toBeGreaterThan(0)
    expect(r.entries[0].name).toBe('img_disk.E01')
  })

  test('browse_filesystem desce por parent_obj_id', () => {
    const r = tools.browseFilesystem(s.ctx, { parentObjId: 10 })
    expect(r.entries.map(/** @param {any} e */ e => e.name)).toContain('notes.txt')
    expect(r.entries.map(/** @param {any} e */ e => e.name)).toContain('secret.docx')
  })

  test('browse_filesystem desce por parent_path', () => {
    const r = tools.browseFilesystem(s.ctx, {
      parentPath: '/img_disk.E01/vol_vol2/Users/alice/',
    })
    expect(r.entries.map(/** @param {any} e */ e => e.name)).toContain('notes.txt')
  })

  test('get_file_metadata retorna hashes, MAC times e status known', () => {
    const r = tools.getFileMetadata(s.ctx, { objId: 12 })
    expect(r.hashes.sha256).toBe('FILE_SHA256_BBB')
    expect(r.known_status).toBe('known bad / notable')
    expect(r.mac_times['modified (mtime)']).toMatch(/UTC/)
    expect(
      r.associated_artifacts.some(/** @param {any} a */ a => a.type_name === 'TSK_EMAIL_MSG')
    ).toBe(true)
  })
})

describe('tools — blackboard, keywords, tags, timeline, contas', () => {
  /** @type {{ dir: string, caseDir: string, dbPath: string, ctx: import('../src/ctx.js').Ctx }} */
  let s
  beforeEach(() => (s = setup()))
  afterEach(() => rmSync(s.dir, { recursive: true, force: true }))

  test('query_blackboard_artifacts sem tipo lista tipos com contagem', () => {
    const r = tools.queryBlackboardArtifacts(s.ctx, {})
    const t = r.available_artifact_types.find(
      /** @param {any} a */ a => a.type_name === 'TSK_WEB_HISTORY'
    )
    expect(t.count).toBe(1)
  })

  test('query_blackboard_artifacts por type_name decodifica atributos', () => {
    const r = tools.queryBlackboardArtifacts(s.ctx, { artifactType: 'TSK_WEB_HISTORY' })
    expect(r.artifacts.length).toBe(1)
    const attrs = r.artifacts[0].attributes
    expect(attrs.URL).toBe('https://bitcoin.example/wallet')
    expect(attrs['Date Accessed']).toMatch(/UTC/)
  })

  test('query_blackboard_artifacts por id numérico funciona', () => {
    const r = tools.queryBlackboardArtifacts(s.ctx, { artifactType: '4' })
    expect(r.artifacts.length).toBe(1)
  })

  test('tipo inexistente lista os disponíveis no erro', () => {
    expect(() => tools.queryBlackboardArtifacts(s.ctx, { artifactType: 'TSK_NADA' })).toThrow(
      /Tipos disponíveis/
    )
  })

  test('search_keywords encontra em filenames e artifacts', () => {
    const r = tools.searchKeywords(s.ctx, { keyword: 'notes', scope: 'filenames' })
    expect(r.filename_matches[0].path).toContain('notes.txt')

    const r2 = tools.searchKeywords(s.ctx, { keyword: 'bitcoin', scope: 'artifacts' })
    expect(r2.artifact_matches[0].value_excerpt).toContain('bitcoin')
  })

  test('browse_tags lista tags com contagens por tipo', () => {
    const r = tools.browseTags(s.ctx, {})
    expect(r.tags[0].display_name).toBe('Interessante')
    expect(r.tags[0].file_count).toBe(1)
    expect(r.tags[0].artifact_count).toBe(1)
  })

  test('browse_timeline filtra tsk_files por janela mtime', () => {
    const r = tools.browseTimeline(s.ctx, {
      start: 1700000000,
      end: 1700002000,
      field: 'mtime',
    })
    expect(r.events.length).toBe(3)
    expect(
      r.events.every(/** @param {any} e */ e => e.time >= 1700000000 && e.time <= 1700002000)
    ).toBe(true)
  })

  test('get_os_accounts retorna contas com detalhes', () => {
    const r = tools.getOsAccounts(s.ctx, {})
    expect(r.accounts[0].identifier).toBe('alice')
    expect(r.accounts[0].display_name).toBe('Alice Admin')
  })

  test('search_keyword_hits retorna hits com excerpt', () => {
    const r = tools.searchKeywordHits(s.ctx, { keyword: 'bitcoin', limit: 10 })
    expect(r.hits[0].excerpt).toContain('bitcoin')
    expect(r.hits[0].file_obj_id).toBe(11)
  })

  test('tools sem caso ativo lançam DbError com hint', () => {
    const ctx = createCtx({ casesDir: s.dir, exportDir: null, filesRoot: null })
    expect(() => tools.getCaseSummary(ctx, {})).toThrow(/set_active_case|list_cases/i)
  })
})
