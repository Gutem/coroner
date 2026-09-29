import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeLegacyCase } from './fixtures/make-case.js'

const tools = await import('../src/tools.js')
const { createCtx } = await import('../src/ctx.js')

/**
 * Schema 9 (Autopsy 4.x antigo), como nos cases reais do usuário:
 * sem file_tags/artifact_tags/keyword_hits/os_accounts; tem content_tags,
 * blackboard_artifact_tags, tag_names.knownStatus e tsk_os_accounts/tsk_events.
 */
describe('compatibilidade com schema legacy (Autopsy 4.x)', () => {
  /** @type {{ dir: string, ctx: import('../src/ctx.js').Ctx }} */
  let s
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'autopsy-legacy-'))
    const { caseDir } = makeLegacyCase(dir)
    const ctx = createCtx({ casesDir: dir, exportDir: null, filesRoot: null })
    ctx.setActiveCase(caseDir)
    s = { dir, ctx }
  })
  afterEach(() => rmSync(s.dir, { recursive: true, force: true }))

  test('browse_tags usa content_tags/blackboard_artifact_tags e knownStatus', () => {
    const r = tools.browseTags(s.ctx, {})
    expect(r.tags[0].display_name).toBe('Interessante')
    expect(r.tags[0].file_count).toBe(1)
    expect(r.tags[0].artifact_count).toBe(1)
    expect(r.tags[0].known_status).toBe('known bad / notable')
  })

  test('get_os_accounts lê tsk_os_accounts com realm e data sources', () => {
    const r = tools.getOsAccounts(s.ctx, {})
    expect(r.count).toBe(3)
    const alice = r.accounts.find(/** @param {any} a */ a => a.login_name === 'ALICE')
    expect(alice.full_name).toBe('Alice Admin')
    expect(alice.realm).toBe('DESKTOP-ALICE')
    expect(alice.data_sources).toEqual([1])
    expect(alice.file_count).toBe(1)
  })

  test('conta sem nome cai no SID (addr) como label', () => {
    const r = tools.getOsAccounts(s.ctx, {})
    const anon = r.accounts.find(/** @param {any} a */ a => a.os_account_obj_id === 910)
    expect(anon.login_name).toBe(null)
    expect(anon.label).toBe('S-1-5-21-2166083798-3953003113-1225838991-1002')
    expect(anon.sid).toBe('S-1-5-21-2166083798-3953003113-1225838991-1002')
    expect(anon.file_count).toBe(0)
  })

  test('get_case_summary expõe versões e examiners, e avisa o que não existe', () => {
    const r = tools.getCaseSummary(s.ctx, {})
    expect(r.schema_major).toBe(9)
    expect(r.schema_minor).toBe(6)
    expect(r.tsk_version).toBe(68419839)
    expect(r.examiners[0].display_name).toBe('Analista')
    expect(r.case_metadata_available).toBe(false)
    expect(r.metadata_note).toMatch(/fora do autopsy\.db|não guarda/i)
  })

  test('get_file_metadata resolve a conta dona do arquivo', () => {
    const r = tools.getFileMetadata(s.ctx, { objId: 11 })
    expect(r.owner_account.login_name).toBe('ALICE')
    expect(r.owner_account.full_name).toBe('Alice Admin')
  })

  test('search_keyword_hits degrada com explicação quando não há tabela', () => {
    const r = tools.searchKeywordHits(s.ctx, { keyword: 'bitcoin' })
    expect(r.available).toBe(false)
    expect(r.reason).toMatch(/Lucene|index/i)
    expect(r.hint).toMatch(/search_keywords/)
  })

  test('browse_filesystem atravessa nós intermediários sem tsk_files', () => {
    // 1 (data source) -> 2 (volume system) -> 3 (volume) -> 5 (fs) -> 6 (raiz) -> 10 -> 11
    const nivel1 = tools.browseFilesystem(s.ctx, { parentObjId: 1 })
    expect(nivel1.entries.length).toBe(1)
    expect(nivel1.entries[0].obj_id).toBe(2)
    expect(nivel1.entries[0].name).toBe(null)
    expect(nivel1.entries[0].kind).toBe('volume system')

    const nivel2 = tools.browseFilesystem(s.ctx, { parentObjId: 2 })
    expect(nivel2.entries[0].kind).toBe('volume/partition')

    const nivel3 = tools.browseFilesystem(s.ctx, { parentObjId: 3 })
    expect(nivel3.entries[0].obj_id).toBe(5)
    expect(nivel3.entries[0].kind).toBe('filesystem')

    const nivel4 = tools.browseFilesystem(s.ctx, { parentObjId: 5 })
    expect(nivel4.entries[0].obj_id).toBe(6)

    const nivel5 = tools.browseFilesystem(s.ctx, { parentObjId: 6 })
    expect(nivel5.entries.map(/** @param {any} e */ e => e.name)).toContain('Users')

    const nivel6 = tools.browseFilesystem(s.ctx, { parentObjId: 10 })
    expect(nivel6.entries.map(/** @param {any} e */ e => e.name)).toContain('notes.txt')
  })

  test('raízes incluem os filesystems (atalho para pular os volumes)', () => {
    const r = tools.browseFilesystem(s.ctx, {})
    const fs = r.entries.find(/** @param {any} e */ e => e.kind === 'filesystem')
    expect(fs.obj_id).toBe(5)
    expect(fs.fs_type).toBe(8)
    expect(fs.img_offset).toBe(1048576)
    expect(r.entries.some(/** @param {any} e */ e => e.kind === 'data source')).toBe(true)
  })

  test('browse_timeline com order=desc traz os mais recentes sem offset profundo', () => {
    const r = tools.browseTimeline(s.ctx, {
      start: 1700000000,
      end: 1700004000,
      order: 'desc',
      limit: 2,
    })
    expect(r.order).toBe('desc')
    expect(r.events.length).toBe(2)
    expect(r.events[0].time).toBe(1700003000)
    expect(r.events[0].time > r.events[1].time).toBe(true)
    expect(r.total_in_window).toBe(3)
  })

  test('browse_timeline usa tsk_events quando existe', () => {
    const r = tools.browseTimeline(s.ctx, { start: 1700000000, end: 1700004000 })
    expect(r.source).toBe('tsk_events')
    expect(r.events.length).toBe(3)
    expect(r.total_in_window).toBe(3)
    expect(r.events[0].time_utc).toMatch(/UTC/)
    expect(r.events[0].type).toBe('File System')
    expect(r.events[0].description).toContain('notes.txt')
  })
})
