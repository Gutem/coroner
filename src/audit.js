import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DbError } from './db.js'

/** Hash inicial da cadeia (sem registro anterior). */
export const AUDIT_GENESIS = '0'.repeat(64)

/**
 * Normaliza um valor para caber no log sem despejar dado de evidência:
 * strings longas são truncadas e objetos viram JSON limitado.
 * @param {any} value
 * @param {number} [max]
 */
function shrink(value, max = 2000) {
  if (value === null || value === undefined) return null
  let s
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    s = String(value)
  }
  if (typeof s !== 'string') return null
  return s.length > max ? `${s.slice(0, max)}…(truncado)` : s
}

/**
 * Resumo do resultado: só números/estado — nunca o conteúdo da evidência.
 * @param {any} payload
 */
function summarize(payload) {
  if (!payload || typeof payload !== 'object') return null
  /** @type {Record<string, any>} */
  const out = {}
  for (const k of [
    'count',
    'row_count',
    'total_files',
    'total_artifacts',
    'total_messages',
    'total_in_window',
    'conversation_count',
    'cases_found',
    'status',
    'truncated',
    'available',
    'content_verified',
    'matched_by',
    'source',
  ]) {
    if (payload[k] !== undefined) out[k] = payload[k]
  }
  return Object.keys(out).length ? out : null
}

/**
 * Cria um log de auditoria append-only (NDJSON) com **encadeamento de hash**:
 * cada registro guarda `prev` e `hash`, então editar/remover/reordenar uma linha
 * quebra a cadeia e é detectável por `verifyAuditLog` — inclusive por terceiro.
 *
 * @param {{ path: string, session?: string, caseDirOf?: () => (string | null) }} opts
 */
export function createAuditLog({ path, session = 'local', caseDirOf }) {
  if (!path) throw new DbError('AUTOPSY_AUDIT_LOG não definido (caminho do log de auditoria).')
  const logPath = resolve(path)

  const assertOutsideCase = () => {
    const caseDir = caseDirOf ? caseDirOf() : null
    if (!caseDir) return
    const rel = relative(resolve(caseDir), logPath)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      throw new DbError(
        `O log de auditoria não pode ficar dentro do case (cadeia de custódia): ${logPath}`
      )
    }
  }
  assertOutsideCase()

  let prev = AUDIT_GENESIS
  let seq = 0
  if (existsSync(logPath)) {
    let lines
    try {
      lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new DbError(`Log de auditoria existente ilegível (${logPath}): ${msg}`)
    }
    if (lines.length) {
      try {
        const last = JSON.parse(lines[lines.length - 1])
        if (!last.hash || typeof last.seq !== 'number') throw new Error('sem hash/seq')
        prev = last.hash
        seq = last.seq
      } catch {
        throw new DbError(
          `Log de auditoria existente está corrompido (${logPath}). Não reinicio a cadeia silenciosamente: preserve o arquivo, investigue e só então recomece com um caminho novo.`
        )
      }
    }
  }

  return {
    path: logPath,
    get seq() {
      return seq
    },
    /**
     * Anexa um registro. Falha de escrita **interrompe** (fail-closed): sem log
     * confiável, o exame não é considerado válido.
     * @param {{ tool: string, args?: any, case?: any, ok?: boolean, error?: string,
     *           result?: any, duration_ms?: number }} event
     */
    record(event) {
      assertOutsideCase()
      seq += 1
      const base = {
        seq,
        ts_utc: new Date().toISOString(),
        session,
        case: event.case
          ? { label: event.case.label ?? null, db: event.case.dbPath ?? null }
          : null,
        tool: event.tool,
        args: shrink(event.args),
        ok: event.ok !== false,
        error: event.error ? shrink(event.error, 500) : null,
        result: summarize(event.result),
        duration_ms: event.duration_ms ?? null,
        prev,
      }
      const hash = createHash('sha256')
        .update(prev + JSON.stringify(base))
        .digest('hex')
      const line = `${JSON.stringify({ ...base, hash })}\n`
      try {
        appendFileSync(logPath, line)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new DbError(
          `Falha ao gravar o log de auditoria (${logPath}): ${msg}. Exame interrompido (fail-closed): sem log não há validade.`
        )
      }
      prev = hash
      return { seq, hash }
    },
  }
}

/**
 * Verifica a integridade da cadeia de um log de auditoria. Qualquer edição,
 * remoção ou reordenação é detectada e localizada pelo `seq`.
 * @param {string} path
 */
export function verifyAuditLog(path) {
  const logPath = resolve(path)
  if (!existsSync(logPath)) return { ok: false, reason: 'arquivo inexistente', path: logPath }
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
  let prev = AUDIT_GENESIS
  for (let i = 0; i < lines.length; i++) {
    /** @type {any} */
    let rec
    try {
      rec = JSON.parse(lines[i])
    } catch {
      return {
        ok: false,
        reason: `linha ${i + 1} não é JSON`,
        broken_at: i + 1,
        count: lines.length,
        path: logPath,
      }
    }
    const { hash, ...base } = rec
    const expected = createHash('sha256')
      .update(prev + JSON.stringify(base))
      .digest('hex')
    if (rec.prev !== prev || hash !== expected) {
      return {
        ok: false,
        reason: 'cadeia de hash quebrada (registro editado, removido ou reordenado)',
        broken_at: rec.seq ?? i + 1,
        count: lines.length,
        path: logPath,
      }
    }
    prev = hash
  }
  return { ok: true, count: lines.length, last_hash: prev, path: logPath, algorithm: 'sha256' }
}

// ---------------------------------------------------------------------------
// Trilha rotativa por caso
// ---------------------------------------------------------------------------

/**
 * Descobre se o alvo é um arquivo único ou um diretório/pattern rotativo.
 * - contém `{case}` -> usa como pattern
 * - termina com separador, é diretório existente, ou é um caminho inexistente SEM
 *   extensão (basename sem '.') -> rotativo: `<dir>/audit-{case}-{hash}.ndjson`
 * - caso contrário -> arquivo único (compatível com o comportamento anterior)
 * @param {string} target
 * @returns {{ mode: 'single' | 'rotating', pattern: string, dir: string }}
 */
export function resolveAuditTarget(target) {
  const raw = String(target)
  const resolved = resolve(raw)
  const endsWithSep = /[\\/]$/.test(raw)
  if (raw.includes('{case}')) {
    return { mode: 'rotating', pattern: resolved, dir: dirname(resolved) }
  }
  const exists = existsSync(resolved)
  const isDir = exists && statSync(resolved).isDirectory()
  // inexistente e sem extensão no basename: tratado como diretório de trilhas
  const looksLikeDir = !exists && !basename(resolved).includes('.')
  if (endsWithSep || isDir || looksLikeDir) {
    return {
      mode: 'rotating',
      pattern: join(resolved, 'audit-{case}-{hash}.ndjson'),
      dir: resolved,
    }
  }
  return { mode: 'single', pattern: resolved, dir: dirname(resolved) }
}

/**
 * Rótulo do case -> nome de arquivo seguro.
 * @param {string | null | undefined} label
 */
export function sanitizeCaseLabel(label) {
  // não removemos underscores: o sentinela de "sem case ativo" é `_session`
  const safe = String(label ?? '_session')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 60)
  return safe || '_session'
}

/**
 * Caminho do arquivo de trilha para o case ativo (ou o de sessão, antes de ativar).
 * @param {string | { mode: string, pattern: string }} target
 * @param {{ label?: string | null, caseDir?: string | null, dbPath?: string | null } | null} active
 */
export function auditPathFor(target, active) {
  const t = typeof target === 'string' ? resolveAuditTarget(target) : target
  if (t.mode === 'single') return t.pattern
  const label = sanitizeCaseLabel(active?.label ?? null)
  const seed = active?.caseDir || active?.dbPath || label
  const hash = createHash('sha256').update(String(seed)).digest('hex').slice(0, 8)
  return t.pattern.replace('{case}', label).replace('{hash}', hash)
}

/**
 * Roteia registros para o arquivo do case ativo, reaproveitando o logger de cada
 * arquivo (a cadeia continua de onde parou). Resolve o caso "um exame por trilha":
 * o anexo do laudo é só o arquivo daquele case.
 *
 * @param {{ target: string, caseOf?: () => ({ label?: string | null, caseDir?: string | null,
 *           dbPath?: string | null } | null), session?: string }} opts
 */
export function createAuditRouter({ target, caseOf, session = 'local' }) {
  const resolved = resolveAuditTarget(target)
  /** @type {Map<string, ReturnType<typeof createAuditLog>>} */
  const logs = new Map()
  let current = resolved.pattern

  const pathNow = () => auditPathFor(resolved, caseOf ? caseOf() : null)

  /** @param {string} p */
  const loggerFor = p => {
    let logger = logs.get(p)
    if (!logger) {
      try {
        mkdirSync(dirname(p), { recursive: true })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new DbError(
          `Não foi possível criar o diretório do log de auditoria (${dirname(p)}): ${msg}`
        )
      }
      logger = createAuditLog({
        path: p,
        session,
        caseDirOf: () => (caseOf ? (caseOf()?.caseDir ?? null) : null),
      })
      logs.set(p, logger)
    }
    return logger
  }

  // modo arquivo único: valida e abre já na inicialização — configuração errada
  // (ex.: log dentro do case, caminho impossível) falha rápido, não no meio do exame
  if (resolved.mode === 'single') loggerFor(resolved.pattern)

  return {
    mode: resolved.mode,
    /** caminho do arquivo atualmente ativo */
    currentPath() {
      current = pathNow()
      return current
    },
    /**
     * @param {{ tool: string, args?: any, case?: any, ok?: boolean, error?: string,
     *           result?: any, duration_ms?: number }} event
     */
    record(event) {
      const p = pathNow()
      current = p
      return loggerFor(p).record({
        ...event,
        case: event.case ?? (caseOf ? caseOf() : null),
      })
    },
    /** arquivos já tocados nesta sessão */
    files() {
      return [...logs.keys()]
    },
  }
}
