import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPublicKey, verify as cryptoVerify, generateKeyPairSync } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createAuditLog } = await import('../src/audit.js')
const { sealAuditLog, verifySeal, buildTimestampRequest, signablePayload, pathBasename } =
  await import('../src/seal.js')

/**
 * cria um log de auditoria com N registros em dir
 * @param {string} dir
 * @param {number} [n]
 */
function makeLog(dir, n = 3) {
  const logPath = join(dir, 'audit.ndjson')
  const log = createAuditLog({ path: logPath })
  for (let i = 0; i < n; i++) log.record({ tool: `t${i}`, ok: true, args: { i } })
  return logPath
}

const hasOpenssl = () => Bun.spawnSync(['openssl', 'version']).exitCode === 0

/**
 * Certificado self-signed RSA descartavel (simula um A1 fora da cadeia ICP-Brasil).
 * @param {string} dir @param {string} [cn]
 * @returns {{ key: string, cert: string, keyPath: string, certPath: string }}
 */
function selfSignedCert(dir, cn = 'Perito Teste') {
  const tag = cn.replace(/\W/g, '')
  const keyPath = join(dir, `key-${tag}.pem`)
  const certPath = join(dir, `cert-${tag}.pem`)
  const r = Bun.spawnSync(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '30',
      '-nodes',
      '-subj',
      `/C=BR/O=Pericia Teste/CN=${cn}`,
    ],
    { stderr: 'ignore' }
  )
  if (r.exitCode !== 0) throw new Error('openssl req falhou (certificado de teste)')
  return {
    key: readFileSync(keyPath, 'utf8'),
    cert: readFileSync(certPath, 'utf8'),
    keyPath,
    certPath,
  }
}

describe('selo do log de auditoria', () => {
  /** @type {string} */ let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autopsy-seal-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('gera selo com sha256 do log e resultado da cadeia', async () => {
    const logPath = makeLog(dir, 3)
    const outPath = join(dir, 'selo.json')
    const seal = await sealAuditLog({ logPath, outPath })
    expect(existsSync(outPath)).toBe(true)
    expect(seal.log.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(seal.chain.ok).toBe(true)
    expect(seal.chain.count).toBe(3)
    expect(seal.log.bytes).toBe(readFileSync(logPath).length)
    expect(JSON.parse(readFileSync(outPath, 'utf8')).log.sha256).toBe(seal.log.sha256)
  })

  test('arquiva uma copia do log e recusa sobrescrever arquivo existente', async () => {
    const logPath = makeLog(dir, 2)
    const archivePath = join(dir, 'arquivo', 'audit.ndjson')
    const seal = await sealAuditLog({ logPath, outPath: join(dir, 's.json'), archivePath })
    expect(existsSync(archivePath)).toBe(true)
    expect(seal.archive.sha256).toBe(seal.log.sha256)
    await expect(
      sealAuditLog({ logPath, outPath: join(dir, 's2.json'), archivePath })
    ).rejects.toThrow(/já existe/i)
  })

  test('assina o selo (Ed25519) com chave privada fornecida', async () => {
    const logPath = makeLog(dir, 2)
    const { privateKey } = generateKeyPairSync('ed25519')
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const outPath = join(dir, 's.json')
    const seal = await sealAuditLog({ logPath, outPath, privateKeyPem: pem })
    expect(seal.signature.algorithm).toBe('ed25519')
    expect(seal.signature.public_key).toContain('BEGIN PUBLIC KEY')
    // a assinatura confere com a chave publica registrada no proprio selo
    expect(
      cryptoVerify(
        null,
        Buffer.from(JSON.stringify(signablePayload(seal))),
        createPublicKey(seal.signature.public_key),
        Buffer.from(seal.signature.signature, 'base64')
      )
    ).toBe(true)
    // e o verificador do selo aceita o conjunto
    expect((await verifySeal(outPath)).ok).toBe(true)
  })

  test('carimbo de tempo: falha de TSA degrada sem derrubar o selo', async () => {
    const logPath = makeLog(dir, 1)
    const seal = await sealAuditLog({
      logPath,
      outPath: join(dir, 's.json'),
      tsaUrl: 'https://tsa.invalid/tsr',
      fetchImpl: /** @type {any} */ (
        async () => {
          throw new Error('sem rede')
        }
      ),
    })
    expect(seal.timestamp.attempted).toBe(true)
    expect(seal.timestamp.ok).toBe(false)
    expect(seal.timestamp.reason).toMatch(/sem rede/)
    expect(existsSync(join(dir, 's.json'))).toBe(true)
  })

  test('carimbo de tempo: guarda o token quando a TSA responde', async () => {
    const logPath = makeLog(dir, 1)
    const token = Buffer.from('TSR-FAKE-BYTES')
    const seal = await sealAuditLog({
      logPath,
      outPath: join(dir, 's.json'),
      tsaUrl: 'https://tsa.exemplo/tsr',
      fetchImpl: /** @type {any} */ (
        async () => ({ ok: true, arrayBuffer: async () => token.buffer.slice(0) })
      ),
    })
    expect(seal.timestamp.ok).toBe(true)
    expect(seal.timestamp.token_bytes).toBe(token.length)
    expect(existsSync(seal.timestamp.token_path)).toBe(true)
    expect(seal.timestamp.validate_with).toMatch(/openssl ts/)
  })

  test('verifySeal detecta alteracao do log depois do selo', async () => {
    const logPath = makeLog(dir, 2)
    const outPath = join(dir, 's.json')
    await sealAuditLog({ logPath, outPath })
    expect((await verifySeal(outPath)).ok).toBe(true)
    // adultera o log depois de selado
    writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}${JSON.stringify({ seq: 99 })}\n`)
    const v = await verifySeal(outPath)
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/sha256|alterado/i)
  })

  test('CLI: --verify <selo> sai 0 quando integro e 1 quando adulterado (regressao)', async () => {
    const logPath = makeLog(dir, 2)
    const outPath = join(dir, 's.json')
    await sealAuditLog({ logPath, outPath })
    const cli = ['scripts/audit-seal.mjs']

    const ok = Bun.spawnSync(['bun', ...cli, '--verify', outPath])
    expect(ok.exitCode).toBe(0)

    writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}${JSON.stringify({ seq: 99 })}\n`)
    const bad = Bun.spawnSync(['bun', ...cli, '--verify', outPath])
    expect(bad.exitCode).toBe(1)
  })

  test('assina com RSA-SHA256 (caso ICP-Brasil A1) e o verificador aceita', async () => {
    const logPath = makeLog(dir, 2)
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const outPath = join(dir, 's.json')
    const seal = await sealAuditLog({ logPath, outPath, privateKeyPem: pem })
    expect(seal.signature.algorithm).toBe('rsa-sha256')
    expect(seal.signature.public_key_sha256).toMatch(/^[0-9a-f]{64}$/)
    const v = await verifySeal(outPath)
    expect(v.ok).toBe(true)
    expect(v.signature.verified).toBe(true)
    expect(v.signature.via).toBe('public_key')
  })

  test('assina com EC P-256 (DER) e o verificador aceita', async () => {
    const logPath = makeLog(dir, 2)
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const outPath = join(dir, 's.json')
    const seal = await sealAuditLog({ logPath, outPath, privateKeyPem: pem })
    expect(seal.signature.algorithm).toBe('ecdsa-sha256-der')
    expect((await verifySeal(outPath)).ok).toBe(true)
  })

  test('recusa chave de tipo que nao assina (x25519) com mensagem clara', async () => {
    const { privateKey } = generateKeyPairSync('x25519')
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    await expect(
      sealAuditLog({ logPath: makeLog(dir, 1), outPath: join(dir, 's.json'), privateKeyPem: pem })
    ).rejects.toThrow(/nao suportad|não suportad/i)
  })

  test.skipIf(!hasOpenssl())(
    'certificado: embute a cadeia, registra o titular e casa com a chave',
    async () => {
      const id = selfSignedCert(dir)
      const logPath = makeLog(dir, 2)
      const outPath = join(dir, 's.json')
      const seal = await sealAuditLog({
        logPath,
        outPath,
        privateKeyPem: id.key,
        certificatePem: id.cert,
      })
      expect(seal.signature.certificate.subject).toContain('CN=Perito Teste')
      expect(seal.signature.certificate.chain_length).toBe(1)
      expect(seal.signature.certificates.length).toBe(1)
      const v = await verifySeal(outPath)
      expect(v.ok).toBe(true)
      expect(v.signature.via).toBe('certificate')
      expect(v.certificate.valid_at_seal).toBe(true)
    }
  )

  test.skipIf(!hasOpenssl())('certificado de outra chave e recusado na hora de selar', async () => {
    const a = selfSignedCert(dir, 'Chave A')
    const b = selfSignedCert(dir, 'Chave B')
    await expect(
      sealAuditLog({
        logPath: makeLog(dir, 1),
        outPath: join(dir, 's.json'),
        privateKeyPem: a.key,
        certificatePem: b.cert,
      })
    ).rejects.toThrow(/nao corresponde|não corresponde/i)
  })

  test.skipIf(!hasOpenssl())(
    'assinatura RSA confere no openssl (oraculo independente)',
    async () => {
      const id = selfSignedCert(dir, 'Oraculo')
      const logPath = makeLog(dir, 2)
      const outPath = join(dir, 's.json')
      const seal = await sealAuditLog({
        logPath,
        outPath,
        privateKeyPem: id.key,
        certificatePem: id.cert,
      })
      const payloadPath = join(dir, 'payload.json')
      const sigPath = join(dir, 'sig.bin')
      const pubPath = join(dir, 'oracle-pub.pem')
      // `openssl dgst -verify` NAO aceita certificado: extraimos a chave publica dele
      writeFileSync(
        pubPath,
        String(Bun.spawnSync(['openssl', 'x509', '-in', id.certPath, '-pubkey', '-noout']).stdout)
      )
      writeFileSync(payloadPath, JSON.stringify(signablePayload(seal)))
      writeFileSync(sigPath, Buffer.from(seal.signature.signature, 'base64'))
      expect(
        Bun.spawnSync([
          'openssl',
          'dgst',
          '-sha256',
          '-verify',
          pubPath,
          '-signature',
          sigPath,
          payloadPath,
        ]).exitCode
      ).toBe(0)
      // payload adulterado -> openssl reprova
      writeFileSync(
        payloadPath,
        JSON.stringify({ ...signablePayload(seal), sealed_at: '2020-01-01T00:00:00.000Z' })
      )
      expect(
        Bun.spawnSync([
          'openssl',
          'dgst',
          '-sha256',
          '-verify',
          pubPath,
          '-signature',
          sigPath,
          payloadPath,
        ]).exitCode
      ).not.toBe(0)
    }
  )

  test('pathBasename entende separador Windows (selo feito no Windows, verificado no macOS)', () => {
    expect(pathBasename('C:\\code\\audit\\trilhas\\audit-ACME-545d2fc3.ndjson')).toBe(
      'audit-ACME-545d2fc3.ndjson'
    )
    expect(pathBasename('/code/audit/trilhas/x.ndjson')).toBe('x.ndjson')
    expect(pathBasename(null)).toBe('')
  })

  test('selo com caminho Windows acha o log ao lado do selo (regressao)', async () => {
    const logPath = makeLog(dir, 2)
    const sealPath = join(dir, 's.json')
    await sealAuditLog({ logPath, outPath: sealPath })
    // o selo real foi gravado no Windows: o caminho declarado usa backslash
    const raw = JSON.parse(readFileSync(sealPath, 'utf8'))
    raw.log.path = `C:\\code\\audit\\trilhas\\${pathBasename(logPath)}`
    writeFileSync(sealPath, JSON.stringify(raw, null, 2))
    const v = await verifySeal(sealPath)
    expect(v.log_from_archive).toBe(true)
    expect(v.reason ?? '').not.toMatch(/log ausente/)
  })

  test('pacote arquivado (trilha + copia + selo juntos) continua verificavel', async () => {
    const logPath = makeLog(dir, 2)
    const outDir = join(dir, 'pacote')
    mkdirSync(outDir, { recursive: true })
    const sealPath = join(outDir, 'selo.json')
    const archFora = join(dir, 'fora', 'audit.ndjson') // mesmo basename do log declarado
    await sealAuditLog({ logPath, outPath: sealPath, archivePath: archFora })
    // o pacote viaja junto: a copia vai para o lado do selo e o log original sai de cena
    renameSync(archFora, join(outDir, 'audit.ndjson'))
    rmSync(logPath)
    const v = await verifySeal(sealPath)
    expect(v.ok).toBe(true)
    expect(v.log_from_archive).toBe(true)
  })

  test('verifySeal acha o log na copia ao lado do selo quando o original foi arquivado', async () => {
    const logPath = makeLog(dir, 2)
    const archDir = join(dir, 'arquivo')
    mkdirSync(archDir, { recursive: true })
    const sealPath = join(archDir, 'selo.json')
    await sealAuditLog({ logPath, outPath: sealPath, archivePath: join(archDir, 'audit.ndjson') })
    rmSync(logPath) // o caminho declarado no selo deixa de existir (arquivamento)
    const v = await verifySeal(sealPath)
    expect(v.ok).toBe(true)
    expect(v.log_from_archive).toBe(true)
  })

  test('buildTimestampRequest: DER com OID SHA-256 e nonce', () => {
    const req = buildTimestampRequest('a'.repeat(64), 12345)
    expect(req[0]).toBe(0x30) // SEQUENCE
    expect(req.includes(Buffer.from('0609608648016503040201', 'hex'))).toBe(true) // OID sha256
    expect(req.includes(Buffer.from([0x02, 0x02, 0x30, 0x39]))).toBe(true) // INTEGER 12345
    // imprint = 32 bytes do hash binario
    expect(req.includes(Buffer.alloc(32, 0xaa))).toBe(true)
  })
})
