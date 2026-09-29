import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  X509Certificate,
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { verifyAuditLog } from './audit.js'
import { DbError } from './db.js'

/** @param {Buffer|string} data */
const sha256 = data => createHash('sha256').update(data).digest('hex')

// ---------------------------------------------------------------------------
// RFC 3161 — DER mínimo para montar o TimeStampReq
// ---------------------------------------------------------------------------

/** @param {number} n */
function derLength(n) {
  if (n < 0x80) return Buffer.from([n])
  /** @type {number[]} */
  const bytes = []
  let v = n
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

/** @param {number} tag @param {Buffer} content */
const derTlv = (tag, content) =>
  Buffer.concat([Buffer.from([tag]), derLength(content.length), content])

/** @param {...Buffer} parts */
const derSequence = (...parts) => derTlv(0x30, Buffer.concat(parts))

/** inteiro positivo em DER @param {number} value */
function derInteger(value) {
  /** @type {number[]} */
  const bytes = []
  let v = value
  if (v === 0) bytes.push(0)
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  }
  if (bytes[0] & 0x80) bytes.unshift(0) // mantém positivo (sem sinal)
  return derTlv(0x02, Buffer.from(bytes))
}

/** @param {Buffer} bytes */
const derOid = bytes => derTlv(0x06, bytes)
const DER_NULL = Buffer.from([0x05, 0x00])

// OID 2.16.840.1.101.3.4.2.1 (SHA-256)
const OID_SHA256 = Buffer.from('608648016503040201', 'hex')

/**
 * Monta o DER de um `TimeStampReq` (RFC 3161) para o hash SHA-256 informado.
 * Estrutura: SEQUENCE { version INTEGER, messageImprint SEQUENCE { algId, hashedMessage }, nonce INTEGER, certReq BOOLEAN }
 * @param {string} hashHex - SHA-256 em hex do que se quer carimbar
 * @param {number} [nonce]
 * @returns {Buffer}
 */
export function buildTimestampRequest(hashHex, nonce = Date.now()) {
  const imprint = derSequence(
    derSequence(derOid(OID_SHA256), DER_NULL),
    derTlv(0x04, Buffer.from(hashHex, 'hex'))
  )
  return derSequence(
    derInteger(1),
    imprint,
    derInteger(nonce),
    Buffer.from([0x01, 0x01, 0xff]) // certReq = TRUE
  )
}

// ---------------------------------------------------------------------------
// Selo
// ---------------------------------------------------------------------------

/**
 * Descreve a chave de assinatura e o algoritmo correspondente.
 * Suporta o que aparece na prática pericial:
 * - `ed25519`            -> integridade técnica (chave do próprio exame)
 * - `rsa` (A1 ICP-Brasil) -> `rsa-sha256` (RSASSA-PKCS1-v1_5, como no openssl `dgst -sha256`)
 * - `ec` (P-256/P-384)   -> `ecdsa-sha256-der` (DER, verifica em openssl/Java)
 * @param {string} pem
 */
export function describeSigningKey(pem) {
  let key
  try {
    key = createPrivateKey(pem)
  } catch (e) {
    throw new DbError(`Chave privada ilegível: ${e instanceof Error ? e.message : String(e)}`)
  }
  const type = key.asymmetricKeyType
  if (type === 'ed25519') return { key, algorithm: 'ed25519', hash: null }
  if (type === 'rsa') return { key, algorithm: 'rsa-sha256', hash: 'sha256' }
  if (type === 'ec') return { key, algorithm: 'ecdsa-sha256-der', hash: 'sha256' }
  throw new DbError(
    `Tipo de chave não suportado para assinatura: ${type}. Use Ed25519, RSA (A1 ICP-Brasil) ou EC P-256/P-384.`
  )
}

/**
 * Último segmento do caminho, aceitando separador POSIX e Windows — o selo pode
 * ter sido feito no Windows (Autopsy) e ser verificado no macOS/Linux, ou vice-versa.
 * @param {string | null | undefined} p
 */
export function pathBasename(p) {
  return (
    String(p ?? '')
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() ?? ''
  )
}

/**
 * Separa uma cadeia PEM em certificados individuais.
 * @param {string} pem
 * @returns {string[]}
 */
export function splitCertificates(pem) {
  return pem
    .split(/(?=-----BEGIN CERTIFICATE-----)/)
    .map(part => part.trim())
    .filter(part => part.includes('-----BEGIN CERTIFICATE-----'))
}

/**
 * A chave privada corresponde ao certificado? (compara o SPKI em DER)
 * @param {string} certPem @param {string} keyPem
 */
export function certificateMatchesKey(certPem, keyPem) {
  const fromCert = new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' })
  const fromKey = createPublicKey(createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' })
  return Buffer.compare(fromCert, fromKey) === 0
}

/**
 * Payload canônico do selo (ordem de chaves fixa) — é o que a assinatura cobre.
 * Exclui `signature` e `timestamp` (o carimbo é validado por si, via openssl ts).
 * @param {any} seal
 */
export function signablePayload(seal) {
  return {
    generated_by: seal.generated_by,
    sealed_at: seal.sealed_at,
    log: seal.log,
    chain: seal.chain,
    archive: seal.archive,
  }
}

/**
 * Sela a trilha de auditoria: calcula o SHA-256 do log, verifica a cadeia,
 * (opcionalmente) arquiva uma cópia, assina o selo (Ed25519) e (opcionalmente)
 * obtém um carimbo de tempo RFC 3161 da TSA configurada.
 *
 * O carimbo é **best-effort**: se a TSA estiver inacessível, o selo sai do mesmo
 * jeito com o motivo registrado (não se perde a trilha por causa de rede).
 *
 * @param {{ logPath: string, outPath: string, archivePath?: string | null,
 *           tsaUrl?: string | null, privateKeyPem?: string | null, certificatePem?: string | null,
 *           fetchImpl?: typeof fetch, now?: Date }} opts
 */
export async function sealAuditLog(opts) {
  const logPath = resolve(opts.logPath)
  if (!existsSync(logPath)) {
    throw new DbError(`Log de auditoria não encontrado: ${logPath}`)
  }
  const outPath = resolve(opts.outPath)
  const bytes = readFileSync(logPath)

  /** @type {any} */
  const payload = {
    generated_by: 'coroner (read-only)',
    sealed_at: (opts.now ?? new Date()).toISOString(),
    log: { path: logPath, bytes: bytes.length, sha256: sha256(bytes) },
    chain: verifyAuditLog(logPath),
    archive: null,
    signature: null,
    timestamp: null,
  }

  if (opts.archivePath) {
    const archivePath = resolve(opts.archivePath)
    if (existsSync(archivePath)) {
      throw new DbError(
        `Arquivo de arquivamento já existe (não sobrescrevo — preserva o histórico de selos): ${archivePath}`
      )
    }
    mkdirSync(dirname(archivePath), { recursive: true })
    writeFileSync(archivePath, bytes)
    payload.archive = { path: archivePath, sha256: sha256(readFileSync(archivePath)) }
  }

  if (opts.privateKeyPem) {
    const { key, algorithm, hash } = describeSigningKey(opts.privateKeyPem)
    const publicKey = createPublicKey(key)
    const canonical = Buffer.from(JSON.stringify(signablePayload(payload)))
    /** @type {any} */
    const info = {
      algorithm,
      signature: cryptoSign(hash, canonical, key).toString('base64'),
      public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      public_key_sha256: sha256(publicKey.export({ type: 'spki', format: 'der' })),
      certificates: null,
      certificate: null,
    }
    // O certificado NÃO entra no payload assinado (como no CMS): ele é a
    // identidade do signatário, não conteúdo. Trocar o certificado quebra a
    // verificação, porque a assinatura deixa de conferir com a nova chave.
    if (opts.certificatePem) {
      const chain = splitCertificates(opts.certificatePem)
      if (!chain.length) {
        throw new DbError('Certificado inválido: nenhum "BEGIN CERTIFICATE" encontrado.')
      }
      if (!certificateMatchesKey(chain[0], opts.privateKeyPem)) {
        throw new DbError(
          'A chave privada não corresponde ao certificado informado (SPKI diferente) — selo recusado.'
        )
      }
      const leaf = new X509Certificate(chain[0])
      info.certificates = chain
      info.certificate = {
        subject: leaf.subject.replace(/\n/g, ', '),
        issuer: leaf.issuer.replace(/\n/g, ', '),
        serial: leaf.serialNumber,
        valid_from: new Date(leaf.validFrom).toISOString(),
        valid_to: new Date(leaf.validTo).toISOString(),
        sha256: sha256(Buffer.from(chain[0])),
        chain_length: chain.length,
      }
    }
    payload.signature = info
  }

  if (opts.tsaUrl) {
    /** @type {any} */
    const info = {
      tsa_url: opts.tsaUrl,
      attempted: true,
      ok: false,
      reason: null,
      token_path: null,
    }
    try {
      const request = buildTimestampRequest(payload.log.sha256)
      const doFetch = opts.fetchImpl ?? fetch
      const res = await doFetch(opts.tsaUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/timestamp-query' },
        body: new Uint8Array(request),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const token = Buffer.from(await res.arrayBuffer())
      if (!token.length) throw new Error('resposta vazia')
      const tokenPath = `${outPath}.tsr`
      writeFileSync(tokenPath, token)
      info.ok = true
      info.token_path = tokenPath
      info.token_bytes = token.length
      info.token_sha256 = sha256(token)
      info.validate_with = `openssl ts -reply -in "${tokenPath}" -text`
    } catch (e) {
      info.reason = e instanceof Error ? e.message : String(e)
    }
    payload.timestamp = info
  }

  const json = JSON.stringify(payload, null, 2)
  writeFileSync(outPath, json)
  return payload
}

/**
 * Verifica um selo: recalcula o SHA-256 do log, confere a cadeia, a assinatura
 * (se houver) e o hash do arquivamento. Detecta alteração do log após o selo.
 * @param {string} sealPath
 */
export async function verifySeal(sealPath) {
  const path = resolve(sealPath)
  if (!existsSync(path)) return { ok: false, reason: 'selo inexistente', path }
  /** @type {any} */
  let seal
  try {
    seal = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    return {
      ok: false,
      reason: `selo ilegível: ${e instanceof Error ? e.message : String(e)}`,
      path,
    }
  }

  /** @type {string[]} */
  const problems = []

  // O log pode ter sido arquivado (deixa o caminho declarado). Nesse caso aceita
  // a cópia ao lado do selo — desde que o sha256 dela seja o que o selo registra.
  let logPath = seal.log?.path ?? ''
  let logFromArchive = false
  if (!existsSync(logPath)) {
    const sidecar = join(dirname(path), pathBasename(logPath))
    if (existsSync(sidecar)) {
      logPath = sidecar
      logFromArchive = true
    }
  }
  if (!existsSync(logPath)) {
    problems.push(`log ausente: ${seal.log?.path}`)
  } else {
    const atual = sha256(readFileSync(logPath))
    if (atual !== seal.log.sha256) {
      problems.push(
        `log alterado desde o selo (sha256 esperado ${String(seal.log.sha256).slice(0, 16)}…, atual ${atual.slice(0, 16)}…)`
      )
    }
    const chain = verifyAuditLog(logPath)
    if (!chain.ok) problems.push(`cadeia quebrada em seq=${chain.broken_at}`)
  }

  // a cópia registrada no selo pode ter sido arquivada junto com ele (mesmo basename)
  if (seal.archive?.path) {
    let archivePath = seal.archive.path
    if (!existsSync(archivePath)) {
      const sidecar = join(dirname(path), pathBasename(archivePath))
      if (existsSync(sidecar)) archivePath = sidecar
    }
    if (!existsSync(archivePath)) problems.push(`arquivo selado ausente: ${seal.archive.path}`)
    else if (sha256(readFileSync(archivePath)) !== seal.archive.sha256) {
      problems.push('cópia arquivada não confere com o selo')
    }
  }

  /** @type {any} */
  let signatureCheck = null
  const sig = seal.signature
  if (sig && (sig.certificates?.length || sig.public_key)) {
    /** @type {Record<string, string | null>} */
    const hashes = { ed25519: null, 'rsa-sha256': 'sha256', 'ecdsa-sha256-der': 'sha256' }
    const algorithm = sig.algorithm ?? 'ed25519'
    const hash = algorithm in hashes ? hashes[algorithm] : 'sha256'
    const via = sig.certificates?.length ? 'certificate' : 'public_key'
    const pem = sig.certificates?.length ? sig.certificates[0] : sig.public_key
    try {
      const ok = cryptoVerify(
        hash,
        Buffer.from(JSON.stringify(signablePayload(seal))),
        createPublicKey(pem),
        Buffer.from(sig.signature, 'base64')
      )
      if (!ok) problems.push('assinatura do selo não confere')
      signatureCheck = { algorithm, verified: ok, via }
    } catch (e) {
      problems.push(`assinatura inválida: ${e instanceof Error ? e.message : String(e)}`)
      signatureCheck = {
        algorithm,
        verified: false,
        via,
        reason: e instanceof Error ? e.message : String(e),
      }
    }
    // certificado válido na data em que o selo foi feito? (não repúdio)
    if (sig.certificate?.valid_from && sig.certificate?.valid_to) {
      const at = Date.parse(seal.sealed_at)
      const from = Date.parse(sig.certificate.valid_from)
      const to = Date.parse(sig.certificate.valid_to)
      const validAtSeal = Number.isFinite(at) && at >= from && at <= to
      if (!validAtSeal) problems.push('certificado fora da validade na data do selo')
      signatureCheck.certificate = {
        subject: sig.certificate.subject,
        serial: sig.certificate.serial,
        valid_from: sig.certificate.valid_from,
        valid_to: sig.certificate.valid_to,
        valid_at_seal: validAtSeal,
      }
    }
  }

  return {
    ok: problems.length === 0,
    reason: problems.length ? problems.join('; ') : null,
    path,
    log_sha256: seal.log?.sha256 ?? null,
    log_from_archive: logFromArchive,
    sealed_at: seal.sealed_at ?? null,
    signature: signatureCheck,
    certificate: signatureCheck?.certificate ?? null,
    timestamp: seal.timestamp
      ? {
          ok: seal.timestamp.ok === true,
          tsa_url: seal.timestamp.tsa_url,
          token_path: seal.timestamp.token_path,
        }
      : null,
  }
}
