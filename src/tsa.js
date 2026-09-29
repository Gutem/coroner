/**
 * Verificação de carimbo de tempo RFC 3161 (.tsr) com o `openssl`.
 *
 * O selo guarda o token e a validação é feita por ferramenta independente (não
 * pelo próprio servidor) — é o que um terceiro precisa reproduzir. Duas checagens:
 *
 * 1. **Imprint**: o hash dentro do token tem de ser o SHA-256 do log carimbado
 *    (prova que o carimbo é sobre AQUELE arquivo). Não depende de rede nem de CA.
 * 2. **Cadeia**: com a CA da TSA informada (`-CAfile`), o `openssl ts -verify`
 *    valida a assinatura da TSA e a cadeia até a raiz (prova de quem carimbou).
 *
 * Sem `caPath` o resultado é `trusted_ca: null` — imprint confere, mas a
 * identidade da TSA NÃO foi verificada. Isso é dito explicitamente, nunca
 * apresentado como validação completa.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** @param {Buffer|string} data */
const sha256 = data => createHash('sha256').update(data).digest('hex')

/**
 * Descobre o binário do openssl. No Windows o openssl do Git não fica no PATH
 * de um serviço/serviço agendado, então procuramos também nos lugares usuais.
 * Devolve `null` quando não existe — quem chama deve dizer "não verificado",
 * nunca apresentar isso como assinatura reprovada.
 * @param {string | null} [configured]
 * @returns {string | null}
 */
export function resolveOpenssl(configured = null) {
  if (configured) return configured
  /** @type {string[]} */
  const candidates = ['openssl']
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    candidates.push(
      'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
      'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
      'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
      `${pf}\\OpenSSL-Win64\\bin\\openssl.exe`
    )
  }
  for (const c of candidates) {
    const probe = spawnSync(c, ['version'], { encoding: 'utf8' })
    if (!probe.error && probe.status === 0) return c
  }
  return null
}

/**
 * Extrai o imprint (hex) do dump textual de `openssl ts -reply -text`.
 * O openssl imprime os bytes como hexdump (offset, grupos de 4 bytes e coluna
 * ASCII) sob `Message data:`/`Message imprint:`; concatenamos os bytes e
 * ignoramos a coluna ASCII (separada por 2+ espaços).
 * @param {string} text
 * @returns {string | null}
 */
export function parseImprintHex(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(l => /^Message (data|imprint):/i.test(l))
  if (start < 0) return null
  /** @type {string[]} */
  const chunks = []
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s*[0-9a-f]{4}\s*-\s*([0-9a-f\s-]+?)\s{2,}/.exec(lines[i])
    if (!m) break
    chunks.push(m[1].replace(/[^0-9a-f]/gi, ''))
  }
  const hex = chunks.join('').toLowerCase()
  return /^[0-9a-f]+$/.test(hex) && hex.length >= 32 ? hex : null
}

/**
 * Metadados legíveis do token (status, genTime, serial, TSA, política).
 * @param {string} text - saída de `openssl ts -reply -text`
 */
export function parseTokenText(text) {
  /** @param {RegExp} re */
  const pick = re => {
    const m = re.exec(text)
    return m ? m[1].trim() : null
  }
  const status = pick(/^Status:\s*(.+)$/m)
  return {
    status,
    granted: status !== null && /^granted/i.test(status),
    status_description: pick(/^Status description:\s*(.+)$/m),
    gen_time: pick(/^Time stamp:\s*(.+)$/m),
    serial: pick(/^Serial number:\s*(.+)$/m),
    tsa: pick(/^TSA:\s*(.+)$/m),
    hash_algorithm: pick(/^Hash Algorithm:\s*(.+)$/m),
    policy: pick(/^Policy OID:\s*(.+)$/m),
    imprint: parseImprintHex(text),
  }
}

/**
 * Verifica um token RFC 3161 contra o arquivo que ele carimba.
 *
 * @param {{ tokenPath: string, dataPath: string, caPath?: string | null,
 *           untrustedPath?: string | null, openssl?: string }} opts
 * @returns {{ ok: boolean, token_path: string, data_path: string, status: string | null,
 *             granted: boolean, gen_time: string | null, serial: string | null,
 *             tsa: string | null, hash_algorithm: string | null, policy: string | null,
 *             imprint: string | null, data_sha256: string | null,
 *             imprint_matches_data: boolean, trusted_ca: boolean | null,
 *             ca_verify: any, reason: string | null }}
 */
export function verifyTimestampToken(opts) {
  const openssl = resolveOpenssl(opts.openssl ?? null)
  const token = resolve(opts.tokenPath)
  const data = resolve(opts.dataPath)
  /** @type {any} */
  const out = {
    ok: false,
    token_path: token,
    data_path: data,
    status: null,
    granted: false,
    status_description: null,
    gen_time: null,
    serial: null,
    tsa: null,
    hash_algorithm: null,
    policy: null,
    imprint: null,
    data_sha256: null,
    imprint_matches_data: false,
    trusted_ca: null,
    ca_verify: null,
    reason: null,
  }

  if (!openssl) {
    out.reason =
      'openssl não encontrado (instale ou passe --openssl <caminho>) — carimbo NÃO verificado'
    return out
  }
  if (!existsSync(token)) {
    out.reason = `token inexistente: ${token}`
    return out
  }
  if (!existsSync(data)) {
    out.reason = `arquivo carimbado inexistente: ${data}`
    return out
  }

  const dump = spawnSync(openssl, ['ts', '-reply', '-in', token, '-text'], { encoding: 'utf8' })
  if (dump.error || dump.status !== 0) {
    const detail = (dump.error?.message ?? dump.stderr ?? '').trim().split('\n').pop() ?? ''
    out.reason = `openssl ts -reply falhou: ${detail || `exit ${dump.status}`}`
    return out
  }
  Object.assign(out, parseTokenText(dump.stdout ?? ''))

  out.data_sha256 = sha256(readFileSync(data))
  out.imprint_matches_data = out.imprint !== null && out.imprint === out.data_sha256

  if (!out.granted) out.reason = `token não concedido (status: ${out.status})`
  else if (!out.imprint_matches_data) {
    out.reason = `imprint do token (${out.imprint ?? 'ilegível'}) difere do sha256 do arquivo (${out.data_sha256})`
  }
  out.ok = out.granted && out.imprint_matches_data

  if (opts.caPath) {
    const args = ['ts', '-verify', '-in', token, '-data', data, '-CAfile', resolve(opts.caPath)]
    if (opts.untrustedPath) args.push('-untrusted', resolve(opts.untrustedPath))
    const v = spawnSync(openssl, args, { encoding: 'utf8' })
    const text = `${v.stdout ?? ''}${v.stderr ?? ''}`.trim()
    out.ca_verify = {
      attempted: true,
      ok: v.status === 0,
      exit_code: v.status,
      ca_path: resolve(opts.caPath),
      untrusted_path: opts.untrustedPath ? resolve(opts.untrustedPath) : null,
      output: text.split('\n').slice(-2).join(' | '),
    }
    out.trusted_ca = v.status === 0
    if (v.status !== 0) {
      out.ok = false
      out.reason = `${out.reason ? `${out.reason}; ` : ''}cadeia da TSA não valida com a CA informada`
    }
  }
  return out
}
