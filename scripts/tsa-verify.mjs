#!/usr/bin/env bun
/**
 * Verifica o carimbo de tempo RFC 3161 (.tsr) de um selo — por terceiro.
 *
 * Uso:
 *   bun scripts/tsa-verify.mjs --seal <selo.json> [--ca <raiz-da-tsa.pem>] [--untrusted <tsa.pem>]
 *   bun scripts/tsa-verify.mjs --token <x.tsr> --data <arquivo-carimbado> [--ca <pem>]
 *
 * Sem --ca o imprint é conferido (o hash dentro do token é o do arquivo), mas a
 * IDENTIDADE da TSA não é validada — o resultado sai com "trusted_ca": null.
 * Para validade jurídica informe a CA da TSA (ICP-Brasil: a cadeia da ACT).
 *
 * Exit code: 0 = ok, 1 = reprovado, 2 = uso incorreto.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathBasename } from '../src/seal.js'
import { verifyTimestampToken } from '../src/tsa.js'

const argv = process.argv.slice(2)
/** @type {Record<string, string>} */
const opts = {}
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[++i]
}

const usage =
  'uso: bun scripts/tsa-verify.mjs --seal <selo.json> [--ca <pem>] [--untrusted <pem>] | --token <tsr> --data <arquivo> [--ca <pem>]'

/** @type {string | null} */
let tokenPath = opts.token ?? null
/** @type {string | null} */
let dataPath = opts.data ?? null

if (!tokenPath && opts.seal) {
  if (!existsSync(opts.seal)) {
    console.error(`selo inexistente: ${opts.seal}`)
    process.exit(2)
  }
  const seal = JSON.parse(readFileSync(opts.seal, 'utf8'))
  tokenPath = seal.timestamp?.token_path ?? null
  dataPath = seal.log?.path ?? null
  if (!tokenPath) {
    console.error('o selo não tem carimbo de tempo (timestamp.token_path ausente)')
    process.exit(2)
  }
  // selo+log arquivados juntos: o caminho declarado pode ter sido movido
  // selo+log+token arquivados juntos: os caminhos declarados podem ter sido movidos
  if (dataPath && !existsSync(dataPath)) {
    const sidecar = join(dirname(opts.seal), pathBasename(dataPath))
    if (existsSync(sidecar)) dataPath = sidecar
  }
  if (!existsSync(tokenPath)) {
    const sidecar = join(dirname(opts.seal), pathBasename(tokenPath))
    if (existsSync(sidecar)) tokenPath = sidecar
  }
}

if (!tokenPath || !dataPath) {
  console.error(usage)
  process.exit(2)
}

const result = verifyTimestampToken({
  tokenPath,
  dataPath,
  caPath: opts.ca ?? null,
  untrustedPath: opts.untrusted ?? null,
  openssl: opts.openssl ?? null,
})

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(1)
if (result.trusted_ca === false) process.exit(1)
process.exit(0)
