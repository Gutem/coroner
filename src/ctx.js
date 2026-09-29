import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DbError } from './db.js'

/**
 * Cria o contexto de sessão: env + case ativo.
 * Cada sessão MCP (stdio ou HTTP) tem seu próprio ctx, então o "case ativo"
 * é isolado por agente.
 *
 * @typedef {ReturnType<typeof createCtx>} Ctx
 * @param {{ casesDir: string, exportDir: string | null, filesRoot: string | null,
 *           auditLog?: string | null, tsaUrl?: string | null,
 *           sealKeyFile?: string | null, sealCertFile?: string | null }} env
 */
export function createCtx(env) {
  /** @type {{ label: string | null, caseDir: string | null, dbPath: string | null }} */
  const state = { label: null, caseDir: null, dbPath: null }
  /** identifica a sessão no log de auditoria */
  const sessionId = randomUUID()
  return {
    env,
    sessionId,
    get active() {
      return { ...state }
    },
    /**
     * Ativa um case: aceita pasta do case ou caminho do autopsy.db.
     * @param {string} casePath
     */
    setActiveCase(casePath) {
      const p = resolve(casePath)
      let dbPath, caseDir
      if (existsSync(p) && statSync(p).isDirectory()) {
        caseDir = p
        dbPath = join(p, 'autopsy.db')
      } else if (basename(p).toLowerCase() === 'autopsy.db') {
        dbPath = p
        caseDir = dirname(p)
      } else {
        caseDir = p
        dbPath = join(p, 'autopsy.db')
      }
      if (!existsSync(dbPath)) {
        throw new DbError(
          `Nenhum autopsy.db encontrado em: ${p}. Passe a pasta do case (a que contém o autopsy.db) ou use list_cases primeiro.`
        )
      }
      state.label = basename(caseDir)
      state.caseDir = caseDir
      state.dbPath = dbPath
    },
  }
}
