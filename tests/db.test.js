import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCase } from './fixtures/make-case.js'

const { openReadonly, DbError } = await import('../src/db.js')

describe('db.js — read-only guarantees', () => {
  /** @type {string} */ let dir
  /** @type {string} */ let caseDir
  /** @type {string} */ let dbPath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coroner-'))
    ;({ caseDir, dbPath } = makeCase(dir))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('abre o autopsy.db e lê tabelas', () => {
    const h = openReadonly(dbPath)
    expect(h.listTables()).toContain('tsk_files')
    const rows = h.query('SELECT COUNT(*) AS c FROM tsk_files')
    expect(rows[0].c).toBe(4)
    h.close()
  })

  test('rejeita INSERT no nível do driver (readonly)', () => {
    const h = openReadonly(dbPath)
    expect(() => h.query('INSERT INTO tag_names VALUES (99, "x", NULL, NULL, 0)')).toThrow(
      /readonly|attempt to write|SQLITE_READONLY/i
    )
    h.close()
  })

  test('erro de tabela inexistente traz a lista de tabelas como hint', () => {
    const h = openReadonly(dbPath)
    try {
      h.query('SELECT * FROM nao_existe LIMIT 1')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(DbError)
      expect(e.message).toMatch(/Tabelas disponíveis/)
      expect(e.message).toContain('tsk_files')
    } finally {
      h.close()
    }
  })

  test('banco travado (lock) gera hint de ingest em andamento', () => {
    const h = openReadonly(dbPath)
    const lock = new Database(dbPath) // grava-lock no arquivo
    lock.exec('BEGIN EXCLUSIVE')
    try {
      h.query('SELECT COUNT(*) AS c FROM tsk_files')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(DbError)
      expect(e.message).toMatch(/locked/i)
    } finally {
      lock.close()
      h.close()
    }
  })

  test('coluna inexistente gera hint de versão de schema', () => {
    const h = openReadonly(dbPath)
    try {
      h.query('SELECT coluna_fantasma FROM tsk_files LIMIT 1')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(DbError)
      expect(e.message).toMatch(/schema/i)
    } finally {
      h.close()
    }
  })

  test('caminho inexistente lança DbError descritivo', () => {
    expect(() => openReadonly(join(caseDir, 'nada.db'))).toThrow(DbError)
  })
})
