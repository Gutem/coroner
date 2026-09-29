import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCase } from './fixtures/make-case.js'

const tools = await import('../src/tools.js')
const { createCtx } = await import('../src/ctx.js')

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'coroner-'))
  const { caseDir } = makeCase(dir)
  const ctx = createCtx({ casesDir: dir, exportDir: null, filesRoot: null })
  ctx.setActiveCase(caseDir)
  return { dir, caseDir, ctx }
}

describe('find_files — busca por tipo, hash e tamanho', () => {
  /** @type {ReturnType<typeof setup>} */ let s
  beforeEach(() => (s = setup()))
  afterEach(() => rmSync(s.dir, { recursive: true, force: true }))

  test('filtra por mimeType', () => {
    const r = tools.findFiles(s.ctx, { mimeType: 'text/plain' })
    expect(r.count).toBe(1)
    expect(r.files[0].name).toBe('notes.txt')
  })

  test('filtra por extensao e por hash sha256', () => {
    expect(tools.findFiles(s.ctx, { extension: 'docx' }).files[0].name).toBe('secret.docx')
    const byHash = tools.findFiles(s.ctx, { sha256: 'FILE_SHA256_BBB' })
    expect(byHash.files[0].obj_id).toBe(12)
  })

  test('filtra por known (notable) e por faixa de tamanho', () => {
    const notable = tools.findFiles(s.ctx, { known: 2 })
    expect(notable.files.map(/** @param {any} f */ f => f.name)).toEqual(['secret.docx'])
    expect(tools.findFiles(s.ctx, { sizeMin: 200 }).count).toBe(1) // >> secret.docx (99999)
  })

  test('filtra por trecho de caminho', () => {
    const r = tools.findFiles(s.ctx, { pathContains: 'alice' })
    expect(r.count).toBe(2)
  })
})

describe('find_artifacts — busca em atributos de qualquer artefato', () => {
  /** @type {ReturnType<typeof setup>} */ let s
  beforeEach(() => (s = setup()))
  afterEach(() => rmSync(s.dir, { recursive: true, force: true }))

  test('busca termo e devolve o artefato com todos os atributos', () => {
    const r = tools.findArtifacts(s.ctx, { term: 'nao conta' })
    expect(r.count).toBe(1)
    const a = r.artifacts[0]
    expect(a.artifact_type).toBe('TSK_MESSAGE')
    expect(a.attributes['Phone Number']).toBe('+5511999991111')
    expect(a.matched_attribute).toBe('Message')
  })

  test('filtra por tipo de artefato', () => {
    const r = tools.findArtifacts(s.ctx, { artifactType: 'TSK_MESSAGE' })
    expect(r.count).toBe(3)
  })
})

describe('extract_conversations — agrupa mensagens por participante', () => {
  /** @type {ReturnType<typeof setup>} */ let s
  beforeEach(() => (s = setup()))
  afterEach(() => rmSync(s.dir, { recursive: true, force: true }))

  test('agrupa por numero, ordena por tempo e extrai corpo/direcao', () => {
    const r = tools.extractConversations(s.ctx, {})
    expect(r.total_messages).toBe(3)
    expect(r.conversations.length).toBe(2)
    const thread = r.conversations.find(
      /** @param {any} c */ c => c.participant === '+5511999991111'
    )
    expect(thread.message_count).toBe(2)
    expect(thread.messages[0].time).toBe(1700002000)
    expect(thread.messages[0].body).toBe('oi, tudo bem?')
    expect(thread.messages[1].direction).toBe('OUTGOING')
    expect(thread.first_utc).toMatch(/UTC/)
  })

  test('filtra por participante e janela de tempo', () => {
    const r = tools.extractConversations(s.ctx, {
      participant: '88882222',
      from: 1700000000,
      to: 1700005000,
    })
    expect(r.conversations.length).toBe(1)
    expect(r.total_messages).toBe(1)
  })
})

describe('open_sqlite — consulta um SQLite de dentro da imagem', () => {
  /** @type {ReturnType<typeof setup>} */ let s
  beforeEach(() => {
    s = setup()
    // cria um "app db" na pasta de Export e aponta o sha256 do notes.txt para ele
    const exportDir = join(s.dir, 'Export')
    mkdirSync(exportDir, { recursive: true })
    const dbPath = join(exportDir, 'msgstore.db')
    const app = new Database(dbPath)
    app.exec(
      'CREATE TABLE message (_id INTEGER, chat_row_id INTEGER, text_data TEXT, timestamp INTEGER)'
    )
    app.exec(
      "INSERT INTO message VALUES (1, 10, 'oi, tudo bem?', 1700002000), (2, 10, 'nao conta pra ninguem', 1700003000)"
    )
    app.exec('CREATE TABLE chat (_id INTEGER, jid TEXT)')
    app.exec("INSERT INTO chat VALUES (10, '5511999991111@s.whatsapp.net')")
    app.close()
    const sha = createHash('sha256').update(readFileSync(dbPath)).digest('hex')
    const raw = new Database(join(s.caseDir, 'autopsy.db'))
    raw.exec(
      `UPDATE tsk_files SET name = 'msgstore.db', extension = 'db', sha256 = '${sha}', size = ${statSync(dbPath).size} WHERE obj_id = 11`
    )
    raw.close()
    s.ctx.env.exportDir = exportDir
  })
  afterEach(() => rmSync(s.dir, { recursive: true, force: true }))

  test('roda SELECT em um SQLite resolvido do case', () => {
    const r = tools.openSqlite(s.ctx, {
      objId: 11,
      sql: 'SELECT m.text_data, m.timestamp, c.jid FROM message m JOIN chat c ON c._id = m.chat_row_id ORDER BY m.timestamp',
    })
    expect(r.error).toBeUndefined()
    expect(r.row_count).toBe(2)
    expect(r.rows[0].jid).toBe('5511999991111@s.whatsapp.net')
    expect(r.rows[1].text_data).toContain('nao conta')
  })

  test('recusa escrita', () => {
    expect(() =>
      tools.openSqlite(s.ctx, { objId: 11, sql: "UPDATE message SET text_data = 'x'" })
    ).toThrow(/somente select|read-only/i)
  })

  test('arquivo que nao e SQLite da erro explicativo', () => {
    const notDb = join(s.dir, 'Export', 'notas.txt')
    writeFileSync(notDb, 'isto nao e um banco sqlite')
    const sha = createHash('sha256').update(readFileSync(notDb)).digest('hex')
    const raw = new Database(join(s.caseDir, 'autopsy.db'))
    raw.exec(
      `UPDATE tsk_files SET name = 'notas.txt', extension = 'txt', sha256 = '${sha}', size = ${Buffer.byteLength('isto nao e um banco sqlite')} WHERE obj_id = 11`
    )
    raw.close()
    expect(() => tools.openSqlite(s.ctx, { objId: 11, sql: 'SELECT 1' })).toThrow(/SQLite/i)
  })
})

describe('export_evidence — extrato citável para o laudo', () => {
  /** @type {ReturnType<typeof setup>} */ let s
  beforeEach(() => (s = setup()))
  afterEach(() => rmSync(s.dir, { recursive: true, force: true }))

  test('escreve JSON fora do case com metadados, hashes e artefatos', () => {
    const out = join(s.dir, 'evidencia.json')
    const r = tools.exportEvidence(s.ctx, { objIds: [11], outPath: out })
    expect(r.status).toBe('ok')
    expect(existsSync(out)).toBe(true)
    const payload = JSON.parse(readFileSync(out, 'utf8'))
    expect(payload.files[0].obj_id).toBe(11)
    expect(payload.files[0].hashes.sha256).toBe('FILE_SHA256_AAA')
    expect(payload.files[0].artifacts.length).toBeGreaterThan(0)
    expect(payload.generated_by).toMatch(/coroner/)
  })

  test('recusa destino dentro do case', () => {
    expect(() =>
      tools.exportEvidence(s.ctx, { objIds: [11], outPath: join(s.caseDir, 'x.json') })
    ).toThrow(/cadeia de custódia/i)
  })
})

describe('open_sqlite — parametros vinculados', () => {
  /** @type {ReturnType<typeof setup>} */ let s
  beforeEach(() => {
    s = setup()
    const exportDir = join(s.dir, 'Export')
    mkdirSync(exportDir, { recursive: true })
    const dbPath = join(exportDir, 'History')
    const app = new Database(dbPath)
    app.exec('CREATE TABLE urls (id INTEGER, url TEXT, visit_count INTEGER)')
    app.exec("INSERT INTO urls VALUES (1, 'https://a.example/x', 9), (2, 'https://b.example/y', 3)")
    app.close()
    const sha = createHash('sha256').update(readFileSync(dbPath)).digest('hex')
    const raw = new Database(join(s.caseDir, 'autopsy.db'))
    raw.exec(
      `UPDATE tsk_files SET name = 'History', sha256 = '${sha}', size = ${statSync(dbPath).size} WHERE obj_id = 11`
    )
    raw.close()
    s.ctx.env.exportDir = exportDir
  })
  afterEach(() => rmSync(s.dir, { recursive: true, force: true }))

  test('aceita params e faz binding posicional', () => {
    const r = tools.openSqlite(s.ctx, {
      objId: 11,
      sql: 'SELECT url, visit_count FROM urls WHERE visit_count > ? ORDER BY visit_count DESC',
      params: [5],
    })
    expect(r.content_verified).toBe(true)
    expect(r.row_count).toBe(1)
    expect(r.rows[0].url).toBe('https://a.example/x')
  })
})

describe('path explicito — desempata homonimos e nao vira leitura arbitraria', () => {
  /** @type {ReturnType<typeof setup>} */ let s
  beforeEach(() => {
    s = setup()
    const exportDir = join(s.dir, 'Export')
    mkdirSync(exportDir, { recursive: true })
    for (const [sub, txt] of [
      ['a', 'historia do perfil A'],
      ['b', 'historia do perfil B'],
    ]) {
      mkdirSync(join(exportDir, sub), { recursive: true })
      writeFileSync(join(exportDir, sub, 'History'), txt)
    }
    const db = new Database(join(s.caseDir, 'autopsy.db'))
    db.exec("UPDATE tsk_files SET name = 'History', sha256 = NULL, size = 20 WHERE obj_id = 11")
    db.close()
    s.ctx.env.exportDir = exportDir
  })
  afterEach(() => rmSync(s.dir, { recursive: true, force: true }))

  test('sem path, ambiguidade e reportada com os candidatos', () => {
    try {
      tools.getFileHex(s.ctx, { objId: 11, offset: 0, length: 4 })
      expect.unreachable()
    } catch (e) {
      expect(e.message).toMatch(/amb.guo/i)
      expect(e.message).toMatch(/Export/)
    }
  })

  test('com path dentro do Export, resolve o arquivo certo', () => {
    const escolhido = join(s.dir, 'Export', 'b', 'History')
    const r = tools.getFileHex(s.ctx, { objId: 11, path: escolhido, offset: 0, length: 8 })
    expect(r.matched_by).toBe('explicit_path')
    expect(r.ascii).toContain('historia')
  })

  test('recusa path fora das raizes permitidas', () => {
    expect(() =>
      tools.getFileHex(s.ctx, {
        objId: 11,
        path: join(s.caseDir, 'autopsy.db'),
        offset: 0,
        length: 4,
      })
    ).toThrow(/fora das raízes/i)
    expect(() =>
      tools.getFileHex(s.ctx, { objId: 11, path: '/etc/hosts', offset: 0, length: 4 })
    ).toThrow(/fora das raízes/i)
  })
})
