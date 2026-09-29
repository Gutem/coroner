import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const { parseImprintHex, parseTokenText, verifyTimestampToken, resolveOpenssl } = await import(
  '../src/tsa.js'
)

const TOKEN = join(import.meta.dir, 'fixtures', 'selo-ACME.json.tsr')
const LOG = join(import.meta.dir, 'fixtures', 'audit-ACME-38db10fa.ndjson')
const LOG_SHA256 = '9adc86628e31cba138d29ae41f33534718443e5e47e53c19a9157b36cd1effa4'
const hasOpenssl = Bun.spawnSync(['openssl', 'version']).exitCode === 0

const DUMP = `Using configuration from /etc/openssl.cnf
Status info:
Status: Granted.
Status description: unspecified
Failure info: unspecified

TST info:
Version: 1
Policy OID: tsa_policy1
Hash Algorithm: sha256
Message data:
    0000 - 9a dc 86 62 8e 31 cb a1-38 d2 9a e4 1f 33 53 47   ...b.1..8....3SG
    0010 - 18 44 3e 5e 47 e5 3c 19-a9 15 7b 36 cd 1e ff a4   .D>^G.<...{6....
Serial number: 0x08A8DDC0
Time stamp: Sep 29 22:40:23 2026 GMT
TSA: DirName:/O=Free TSA/OU=TSA/CN=www.freetsa.org/C=DE
`

describe('parse do dump do openssl ts', () => {
  test('junta o hexdump do imprint e ignora a coluna ascii', () => {
    expect(parseImprintHex(DUMP)).toBe(LOG_SHA256)
  })

  test('extrai status, genTime, serial e TSA', () => {
    const t = parseTokenText(DUMP)
    expect(t.granted).toBe(true)
    expect(t.status).toBe('Granted.')
    expect(t.gen_time).toBe('Sep 29 22:40:23 2026 GMT')
    expect(t.serial).toBe('0x08A8DDC0')
    expect(t.tsa).toContain('CN=www.freetsa.org')
    expect(t.hash_algorithm).toBe('sha256')
  })

  test('dump sem imprint -> null (nao inventa)', () => {
    expect(parseImprintHex('Status: Granted.\n')).toBeNull()
  })
})

describe('resolveOpenssl', () => {
  test('respeita o caminho informado (nao valida o binario)', () => {
    expect(resolveOpenssl('/caminho/do/openssl')).toBe('/caminho/do/openssl')
  })
  test.skipIf(!hasOpenssl)('acha o openssl no PATH', () => {
    const found = resolveOpenssl()
    expect(found).toBeTruthy()
    expect(Bun.spawnSync([String(found), 'version']).exitCode).toBe(0)
  })
})

describe('verifyTimestampToken', () => {
  test('token inexistente -> ok false com motivo', () => {
    const r = verifyTimestampToken({
      tokenPath: join(import.meta.dir, 'nao-existe.tsr'),
      dataPath: LOG,
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/inexistente/)
  })

  test('sem openssl: diz que NAO verificou (nunca que a assinatura e invalida)', () => {
    const r = verifyTimestampToken({
      tokenPath: TOKEN,
      dataPath: LOG,
      openssl: '/nao/existe/openssl',
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/openssl|nao encontrado|não encontrado/i)
    expect(r.imprint).toBeNull() // nao inventamos metadados
  })

  test.skipIf(!hasOpenssl)('token real confere com o log que ele carimba (imprint)', () => {
    const r = verifyTimestampToken({ tokenPath: TOKEN, dataPath: LOG })
    expect(r.granted).toBe(true)
    expect(r.imprint).toBe(LOG_SHA256)
    expect(r.data_sha256).toBe(LOG_SHA256)
    expect(r.imprint_matches_data).toBe(true)
    expect(r.ok).toBe(true)
    expect(r.trusted_ca).toBeNull() // sem CA nao afirmamos confianca
    expect(r.serial).toMatch(/^0x[0-9A-F]+$/)
  })

  test.skipIf(!hasOpenssl)(
    'arquivo diferente -> imprint nao confere e ok false (regressao)',
    () => {
      const r = verifyTimestampToken({
        tokenPath: TOKEN,
        dataPath: join(import.meta.dir, '..', 'package.json'),
      })
      expect(r.imprint_matches_data).toBe(false)
      expect(r.ok).toBe(false)
      expect(r.reason).toMatch(/imprint/i)
    }
  )

  test.skipIf(!hasOpenssl)('CA correta -> trusted_ca true', () => {
    const ca = '/tmp/freetsa-cacert.pem'
    if (!existsSync(ca)) return // CA baixada no fluxo de pericia
    const r = verifyTimestampToken({ tokenPath: TOKEN, dataPath: LOG, caPath: ca })
    expect(r.trusted_ca).toBe(true)
    expect(r.ca_verify.ok).toBe(true)
    expect(r.ok).toBe(true)
  })
})
