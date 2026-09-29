#!/usr/bin/env bun
/**
 * Sela a trilha de auditoria do coroner (hash + arquivamento + assinatura + carimbo)
 * e verifica selos existentes.
 *
 * Uso:
 *   bun scripts/audit-seal.mjs <audit.ndjson> [selo.json] [opcoes]
 *   bun scripts/audit-seal.mjs --verify <selo.json>
 *
 * Opcoes:
 *   --archive <caminho>   copia imutavel do log (recusa sobrescrever)
 *   --tsa <url>           TSA RFC 3161 (ex.: https://freetsa.org/tsr) -> grava <selo>.tsr
 *   --key <pem>           chave privada (PEM): Ed25519, RSA (A1 ICP-Brasil) ou EC P-256/P-384
 *   --cert <pem>          certificado/cadeia (PEM) do signatario: embutido no selo e
 *                         usado para verificar a assinatura (recusa se nao casar com a chave)
 *   --verify <selo.json>  nao sela: verifica um selo existente (inclui oraculo openssl)
 *   --openssl <caminho>   binario do openssl para o oraculo (default: PATH; no Windows
 *                         tentamos tambem o openssl do Git)
 *
 * O --verify confere tambem a assinatura com o openssl (implementacao independente
 * da que assinou): hash + assinatura + cadeia. Para o carimbo de tempo use
 * scripts/tsa-verify.mjs.
 *
 * Exit code: 0 = ok, 1 = selo/verificacao reprovada, 2 = uso incorreto.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sealAuditLog, signablePayload, verifySeal } from '../src/seal.js'
import { resolveOpenssl } from '../src/tsa.js'

/**
 * Oráculo independente: confere a assinatura do selo com o openssl.
 * Implementação distinta da que assinou — é o que tira o "confie em mim".
 * (ed25519 usa `openssl pkeyutl -rawin`; RSA/EC usam `openssl dgst`.)
 * @param {string} sealPath
 */
function opensslOracle(sealPath, configured = null) {
  const seal = JSON.parse(readFileSync(sealPath, 'utf8'))
  const sig = seal.signature
  if (!sig) return { attempted: false, reason: 'selo sem assinatura' }
  // sem a ferramenta nao ha verificacao independente -- mas isso NAO e assinatura reprovada
  const openssl = resolveOpenssl(configured)
  if (!openssl) {
    return {
      attempted: false,
      reason:
        'openssl nao encontrado (instale ou passe --openssl <caminho>) -- assinatura NAO verificada por terceiro',
    }
  }
  const supported = { 'rsa-sha256': 'sha256', 'ecdsa-sha256-der': 'sha256', ed25519: null }
  if (!(sig.algorithm in supported)) {
    return { attempted: false, reason: `algoritmo fora do oraculo: ${sig.algorithm}` }
  }
  const dir = mkdtempSync(join(tmpdir(), 'seal-oracle-'))
  try {
    const pubPath = join(dir, 'pub.pem')
    const pem = sig.certificates?.length ? sig.certificates[0] : sig.public_key
    const pub = sig.certificates?.length
      ? spawnSync(openssl, ['x509', '-pubkey', '-noout'], { input: pem, encoding: 'utf8' })
      : { status: 0, stdout: pem }
    if (pub.status !== 0) {
      return { attempted: true, ok: false, reason: 'nao extraí a chave publica do certificado' }
    }
    writeFileSync(pubPath, pub.stdout ?? '')
    const payloadPath = join(dir, 'payload.json')
    const sigPath = join(dir, 'sig.bin')
    writeFileSync(payloadPath, JSON.stringify(signablePayload(seal)))
    writeFileSync(sigPath, Buffer.from(sig.signature, 'base64'))
    // ed25519 assina a mensagem inteira: nao passa por `dgst` (via pkeyutl -rawin)
    const args =
      sig.algorithm === 'ed25519'
        ? [
            'pkeyutl',
            '-verify',
            '-pubin',
            '-inkey',
            pubPath,
            '-rawin',
            '-in',
            payloadPath,
            '-sigfile',
            sigPath,
          ]
        : [
            'dgst',
            `-${supported[sig.algorithm]}`,
            '-verify',
            pubPath,
            '-signature',
            sigPath,
            payloadPath,
          ]
    const v = spawnSync(openssl, args, { encoding: 'utf8' })
    const out = `${v.stdout ?? ''}${v.stderr ?? ''}`.trim().split('\n').filter(Boolean).pop()
    return {
      attempted: true,
      ok: v.status === 0,
      via: sig.algorithm === 'ed25519' ? 'openssl pkeyutl' : 'openssl dgst',
      openssl,
      output: out ?? null,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const argv = process.argv.slice(2)

/** @type {Record<string, string | boolean>} */
const opts = {}
/** @type {string[]} */
const positional = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--verify') {
    const next = argv[i + 1]
    // aceita `--verify <selo>` ou `--verify` seguido de posicional
    if (next && !next.startsWith('--')) {
      opts.verify = argv[++i]
    } else {
      opts.verify = true
    }
    continue
  }
  if (a.startsWith('--')) {
    opts[a.slice(2)] = argv[++i]
    continue
  }
  positional.push(a)
}

const usage =
  'uso: bun scripts/audit-seal.mjs <audit.ndjson> [selo.json] [--archive p] [--tsa url] [--key pem] [--cert pem] | --verify <selo.json>'

if (!argv.length) {
  console.error(usage)
  process.exit(2)
}

if (opts.verify) {
  const target = typeof opts.verify === 'string' ? opts.verify : positional[0]
  if (!target) {
    console.error(`--verify exige o caminho do selo.json\n${usage}`)
    process.exit(2)
  }
  const result = await verifySeal(target)
  result.openssl_oracle = opensslOracle(target, opts.openssl ? String(opts.openssl) : null)
  console.log(JSON.stringify(result, null, 2))
  const oracleFailed = result.openssl_oracle?.ok === false
  process.exit(result.ok && !oracleFailed ? 0 : 1)
}

const logPath = positional[0]
if (!logPath) {
  console.error(`informe o caminho do audit.ndjson\n${usage}`)
  process.exit(2)
}
const outPath = positional[1] ?? `${logPath}.seal.json`
const keyPath = opts.key ? String(opts.key) : null

const seal = await sealAuditLog({
  logPath,
  outPath,
  archivePath: opts.archive ? String(opts.archive) : null,
  tsaUrl: opts.tsa ? String(opts.tsa) : null,
  privateKeyPem: keyPath ? readFileSync(keyPath, 'utf8') : null,
  certificatePem: opts.cert ? readFileSync(String(opts.cert), 'utf8') : null,
})

console.log(JSON.stringify(seal, null, 2))
process.exit(seal.chain?.ok === false ? 1 : 0)
