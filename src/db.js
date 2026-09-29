import { Database } from 'bun:sqlite'
import { closeSync, existsSync, openSync, readSync } from 'node:fs'

/**
 * Erro com mensagem pensada para auto-correção pelo LLM (hints do schema).
 * @extends Error
 */
export class DbError extends Error {}

/**
 * Abre um autopsy.db em modo STRICT read-only no nível do driver.
 * Qualquer INSERT/UPDATE/DELETE/DDL falha com SQLITE_READONLY — garante a
 * cadeia de custódia do case.
 *
 * @param {string} dbPath - caminho do autopsy.db
 * @returns {{
 *   db: import('bun:sqlite').Database,
 *   listTables: () => string[],
 *   hasTable: (table: string) => boolean,
 *   columns: (table: string) => string[],
 *   query: (sql: string, params?: import('bun:sqlite').SQLQueryBindings[]) => any[],
 *   close: () => void,
 * }}
 */
export function openReadonly(dbPath) {
  if (!existsSync(dbPath)) {
    throw new DbError(
      `O banco do case não existe no disco: ${dbPath}. Use list_cases para ver os cases disponíveis.`
    )
  }
  /** @type {import('bun:sqlite').Database} */
  let db
  try {
    db = new Database(dbPath, { readonly: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new DbError(
      `Não foi possível abrir o banco read-only (${dbPath}): ${msg}. ` +
        'Se o erro for "database is locked", o Autopsy provavelmente está em ingest: tente de novo em alguns segundos.'
    )
  }

  /** @type {string[] | null} */
  let tablesCache = null
  /** @type {Map<string, string[]>} */
  const columnsCache = new Map()

  const listTables = () => {
    if (tablesCache) return tablesCache
    try {
      tablesCache = db
        .query('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
        .all('table')
        .map(r => r.name)
    } catch {
      tablesCache = []
    }
    return tablesCache
  }

  /** @param {string} table */
  const hasTable = table => listTables().includes(table)

  /**
   * Colunas de uma tabela (vazio se a tabela não existir), cacheadas por conexão.
   * @param {string} table
   * @returns {string[]}
   */
  const columns = table => {
    const cached = columnsCache.get(table)
    if (cached) return cached
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return []
    /** @type {string[]} */
    let cols = []
    try {
      cols = db
        .query(`PRAGMA table_info(${table})`)
        .all()
        .map(c => c.name)
    } catch {
      cols = []
    }
    columnsCache.set(table, cols)
    return cols
  }

  /**
   * Executa SELECT e retorna linhas como objetos. Erros viram DbError com hints.
   * @param {string} sql
   * @param {import('bun:sqlite').SQLQueryBindings[]} [params]
   */
  const query = (sql, params = []) => {
    try {
      return db.query(sql).all(...params)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      let hint = ''
      if (/no such table|does not exist/i.test(msg)) {
        const tables = listTables().join(', ') || '(não foi possível listar tabelas)'
        hint = ` Tabelas disponíveis neste case: ${tables}.`
      } else if (/locked|busy/i.test(msg)) {
        hint =
          ' O banco está temporariamente travado (ingest provavelmente em andamento): tente novamente.'
      } else if (/no such column/i.test(msg)) {
        hint =
          ' Confira o nome da coluna: o schema varia conforme a versão do Autopsy (veja get_case_summary).'
      } else if (/readonly/i.test(msg)) {
        hint =
          ' Este server é READ-ONLY por design (cadeia de custódia): escritas não são permitidas.'
      }
      throw new DbError(`Erro de query no banco do case: ${msg}.${hint}`)
    }
  }

  return { db, listTables, hasTable, columns, query, close: () => db.close() }
}

/**
 * Abre um arquivo SQLite (por exemplo um app db extraído da imagem: msgstore.db,
 * ChatStorage.sqlite, History do Chromium) em modo STRICT read-only.
 * Valida a assinatura do arquivo para dar erro claro em não-SQLite.
 *
 * @param {string} filePath
 * @returns {import('bun:sqlite').Database}
 */
export function openSqliteReadonly(filePath) {
  if (!existsSync(filePath)) {
    throw new DbError(`Arquivo não encontrado: ${filePath}`)
  }
  const fd = openSync(filePath, 'r')
  let magic = ''
  try {
    const buf = Buffer.alloc(16)
    readSync(fd, buf, 0, 16, 0)
    magic = buf.toString('latin1')
  } finally {
    closeSync(fd)
  }
  if (!magic.startsWith('SQLite format 3')) {
    throw new DbError(
      `O arquivo não é um SQLite (assinatura ausente): ${filePath}. Se veio de carve/export parcial, extraia novamente.`
    )
  }
  try {
    return new Database(filePath, { readonly: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new DbError(
      `Não foi possível abrir o SQLite read-only (${filePath}): ${msg}. Se o arquivo usa WAL, copie também os -wal/-shm junto dele.`
    )
  }
}

/**
 * Abre conexão readonly com o case ativo do contexto.
 * @param {{ active: { dbPath: string | null, label: string | null } }} ctx
 */
export function connectCase(ctx) {
  if (!ctx.active.dbPath) {
    throw new DbError(
      'Nenhum case ativo. Chame list_cases primeiro e depois set_active_case com o caminho do case.'
    )
  }
  return openReadonly(ctx.active.dbPath)
}
