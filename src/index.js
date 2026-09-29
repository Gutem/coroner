import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createCtx } from './ctx.js'
import { serveHttp, serveStdio } from './server.js'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    transport: { type: 'string' },
    host: { type: 'string' },
    port: { type: 'string' },
  },
  allowPositionals: false,
})

const transport = values.transport ?? process.env.MCP_TRANSPORT ?? 'stdio'
const host = values.host ?? process.env.MCP_HOST ?? '127.0.0.1'
const port = Number(values.port ?? process.env.MCP_PORT ?? 3123)

const env = {
  casesDir: process.env.AUTOPSY_CASES_DIR ?? join(homedir(), 'AutopsyCases'),
  exportDir: process.env.AUTOPSY_EXPORT_DIR || null,
  filesRoot: process.env.AUTOPSY_FILES_ROOT || null,
  auditLog: process.env.AUTOPSY_AUDIT_LOG || null,
  tsaUrl: process.env.AUTOPSY_TSA_URL || null,
  sealKeyFile: process.env.AUTOPSY_SEAL_KEY_FILE || null,
  sealCertFile: process.env.AUTOPSY_SEAL_CERT_FILE || null,
}

console.error(`[coroner] cases_dir=${env.casesDir}`)
console.error(
  `[coroner] export_dir=${env.exportDir ?? '(não configurado — hex/strings/extract indisponíveis)'}`
)
console.error(`[coroner] files_root=${env.filesRoot ?? '(não configurado)'}`)
console.error(
  `[coroner] audit_log=${env.auditLog ?? '(desligado — habilite com AUTOPSY_AUDIT_LOG para trilha com cadeia de hash)'}`
)
console.error(`[coroner] tsa_url=${env.tsaUrl ?? '(sem carimbo de tempo RFC 3161)'}`)
console.error(
  `[coroner] seal_key=${env.sealKeyFile ?? '(sem assinatura)'}${env.sealCertFile ? ' +certificado' : ''}`
)

if (transport === 'http') {
  serveHttp(() => createCtx(env), { host, port })
} else {
  await serveStdio(createCtx(env))
}
