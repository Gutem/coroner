import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCase, makeExportedFiles } from './fixtures/make-case.js'

const tools = await import('../src/tools.js')
const { createCtx } = await import('../src/ctx.js')

describe('content tools — hex/strings/extract via export dir', () => {
  /** @type {{ dir: string, ctx: import('../src/ctx.js').Ctx }} */
  let s
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'coroner-'))
    const { caseDir } = makeCase(dir)
    const content = 'hello forensic world\nbitcoin 0xDEADBEEF\n\n'
    const { dir: exportDir } = makeExportedFiles(dir, [{ name: 'notes.txt', content }])
    // corrige o sha256 de notes.txt (obj_id 11) para o hash real do conteúdo exportado
    const db = new Database(join(caseDir, 'autopsy.db'))
    const realSha = createHash('sha256').update(content).digest('hex')
    db.exec(
      `UPDATE tsk_files SET sha256 = '${realSha}', size = ${Buffer.byteLength(content)} WHERE obj_id = 11`
    )
    db.close()
    const ctx = createCtx({ casesDir: dir, exportDir, filesRoot: null })
    ctx.setActiveCase(caseDir)
    s = { dir, ctx }
  })
  afterEach(() => rmSync(s.dir, { recursive: true, force: true }))

  test('get_file_hex lê slice hex do arquivo exportado (match por sha256)', () => {
    const r = tools.getFileHex(s.ctx, { objId: 11, offset: 0, length: 16 })
    expect(r.matched_by).toBe('export_sha256')
    expect(r.hex).toMatch(/^[0-9a-f\s]+$/)
    expect(r.ascii).toContain('hello forensic')
  })

  test('get_file_hex respeita offset/length', () => {
    const r = tools.getFileHex(s.ctx, { objId: 11, offset: 6, length: 8 })
    expect(r.ascii).toBe('forensic')
  })

  test('get_file_strings extrai strings ASCII com tamanho mínimo', () => {
    const r = tools.getFileStrings(s.ctx, { objId: 11, minLength: 4 })
    expect(r.strings).toContain('hello forensic world')
    expect(r.strings).toContain('bitcoin 0xDEADBEEF')
  })

  test('extract_file copia para outPath fora do case', () => {
    const out = join(s.dir, 'copiado.txt')
    const r = tools.extractFile(s.ctx, { objId: 11, outPath: out })
    expect(r.status).toBe('ok')
    expect(r.written_bytes).toBeGreaterThan(0)
    expect(readFileSync(out, 'utf8')).toContain('forensic')
  })

  test('sem export dir configurado, tools de conteúdo dão hint', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'coroner-'))
    const { caseDir } = makeCase(dir2)
    const ctx = createCtx({ casesDir: dir2, exportDir: null, filesRoot: null })
    ctx.setActiveCase(caseDir)
    try {
      tools.getFileHex(ctx, { objId: 11, offset: 0, length: 8 })
      expect.unreachable()
    } catch (e) {
      expect(e.message).toMatch(/AUTOPSY_EXPORT_DIR|export/i)
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })
})

describe('content tools — FILES_ROOT (mount read-only)', () => {
  test('resolve arquivo por full_path sob filesRoot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coroner-'))
    const { caseDir } = makeCase(dir)
    const root = join(dir, 'mount')
    mkdirSync(join(root, 'img_disk.E01', 'vol_vol2', 'Users', 'alice'), { recursive: true })
    writeFileSync(
      join(root, 'img_disk.E01', 'vol_vol2', 'Users', 'alice', 'notes.txt'),
      'mounted file content'
    )
    const ctx = createCtx({ casesDir: dir, exportDir: null, filesRoot: root })
    ctx.setActiveCase(caseDir)
    const r = tools.getFileHex(ctx, { objId: 11, offset: 0, length: 8 })
    expect(r.matched_by).toBe('files_root')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('resolvedor de conteúdo — efficiente por nome+tamanho, verificado por hash', () => {
  /** @type {{ dir: string, caseDir: string, exportDir: string }} */
  let s
  /** @type {import('../src/ctx.js').Ctx} */
  let ctx

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'coroner-'))
    const { caseDir } = makeCase(dir)
    // Export na pasta do case (auto-detecção, sem env var)
    const exportDir = join(caseDir, 'Export', 'alice')
    mkdirSync(exportDir, { recursive: true })
    s = { dir, caseDir, exportDir }
    ctx = createCtx({ casesDir: dir, exportDir: null, filesRoot: null })
    ctx.setActiveCase(caseDir)
  })
  afterEach(() => rmSync(s.dir, { recursive: true, force: true }))

  /**
   * @param {string} content
   * @param {{ sha?: boolean, name?: string }} [opts]
   */
  const setCaseFile = (content, { sha = true, name = 'notes.txt' } = {}) => {
    const p = join(s.exportDir, name)
    writeFileSync(p, content)
    const realSha = createHash('sha256').update(content).digest('hex')
    const db = new Database(join(s.caseDir, 'autopsy.db'))
    db.exec(
      sha
        ? `UPDATE tsk_files SET sha256 = '${realSha}', size = ${Buffer.byteLength(content)} WHERE obj_id = 11`
        : `UPDATE tsk_files SET sha256 = NULL, size = ${Buffer.byteLength(content)} WHERE obj_id = 11`
    )
    db.close()
    return realSha
  }

  test('auto-detecta <caseDir>/Export e verifica por sha256', () => {
    setCaseFile('conteudo verificado')
    const r = tools.getFileHex(ctx, { objId: 11, offset: 0, length: 8 })
    expect(r.matched_by).toBe('export_sha256')
    expect(r.content_verified).toBe(true)
    expect(r.ascii).toContain('conteudo')
  })

  test('sem sha256 no DB, casa por nome+tamanho e marca como não verificado', () => {
    setCaseFile('sem hash no banco', { sha: false })
    const r = tools.getFileHex(ctx, { objId: 11, offset: 0, length: 8 })
    expect(r.matched_by).toBe('export_nome_tamanho')
    expect(r.content_verified).toBe(false)
  })

  test('hash divergente NÃO resolve (evita entregar arquivo errado)', () => {
    const p = join(s.exportDir, 'notes.txt')
    writeFileSync(p, 'arquivo errado')
    const db = new Database(join(s.caseDir, 'autopsy.db'))
    db.exec("UPDATE tsk_files SET sha256 = 'hash-que-nao-bate', size = 14 WHERE obj_id = 11")
    db.close()
    expect(() => tools.getFileHex(ctx, { objId: 11, offset: 0, length: 4 })).toThrow(
      /não disponível|AUTOPSY_EXPORT_DIR/i
    )
  })

  test('ambiguidade (mesmo nome e tamanho) é resolvida pelo hash', () => {
    const bom = setCaseFile('AAAABBBB') // 8 bytes, hash correto no DB
    const outro = join(s.caseDir, 'Export', 'bob')
    mkdirSync(outro, { recursive: true })
    writeFileSync(join(outro, 'notes.txt'), 'CCCCDDDD') // mesmo nome, mesmo tamanho, conteúdo diferente
    const r = tools.getFileHex(ctx, { objId: 11, offset: 0, length: 8 })
    expect(r.content_verified).toBe(true)
    expect(r.ascii).toBe('AAAABBBB')
    expect(bom).toBe(createHash('sha256').update('AAAABBBB').digest('hex'))
  })
})
