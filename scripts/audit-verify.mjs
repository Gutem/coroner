#!/usr/bin/env bun
/**
 * Verificador independente do log de auditoria do coroner.
 *
 * Recalcula a cadeia de hash e aponta o primeiro registro divergente. Um terceiro
 * (assistente técnico da parte, perito do juízo) roda este script no arquivo de
 * log e comprova que nenhum registro foi editado, removido ou reordenado.
 *
 * Uso:
 *   bun scripts/audit-verify.mjs <audit.ndjson>
 *
 * Saída: JSON com { ok, count, last_hash, algorithm, path } ou { ok:false, broken_at, reason }.
 * Exit code: 0 = íntegro, 1 = cadeia quebrada, 2 = uso incorreto.
 */
import { verifyAuditLog } from '../src/audit.js'

const target = process.argv[2]
if (!target) {
  console.error('uso: bun scripts/audit-verify.mjs <audit.ndjson>')
  process.exit(2)
}

const result = verifyAuditLog(target)
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
