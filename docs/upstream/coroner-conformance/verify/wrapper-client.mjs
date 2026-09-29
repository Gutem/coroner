/**
 * Cliente MCP (SDK oficial) que fala com o wrapper de stdio e chama `tools/list`.
 *
 * É a verificação cliente-visível: o SDK valida a resposta contra `ListToolsResult`, então um
 * envelope duplo (`{"tools":{"tools":[…]}}`) faz o cliente falhar na hora -- exatamente o que o
 * Claude Desktop veria. Serve para as duas rodadas: wrapper upstream (deve falhar) e com o patch
 * aplicado (deve listar as tools).
 *
 * Uso: node wrapper-client.mjs <caminho-do-wrapper.js> <LOCALAPPDATA-falso>
 * Saída: "listTools OK: N tools" (exit 0) ou "listTools FAIL: …" (exit 1).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const [wrapper, lappdata] = process.argv.slice(2)
if (!wrapper || !lappdata) {
  console.error('uso: node wrapper-client.mjs <wrapper.js> <LOCALAPPDATA>')
  process.exit(2)
}

// o SDK pode sinalizar resposta inválida por erro de transporte (fora do try), então o mesmo
// desfecho (FAIL) precisa valer para exceção não tratada — senão o script morre com stack trace
// e o harness não consegue distinguir "falhou como esperado" de "quebrou".
const resumo = e =>
  String(e?.message ?? e)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
const falhar = msg => {
  console.log(`listTools FAIL: ${msg}`)
  process.exit(1)
}
process.on('unhandledRejection', e => falhar(resumo(e)))
process.on('uncaughtException', e => falhar(resumo(e)))

const client = new Client({ name: 'coroner-verify', version: '0.0.0' }, { capabilities: {} })
const transport = new StdioClientTransport({
  command: 'node',
  args: [wrapper],
  env: { ...process.env, LOCALAPPDATA: lappdata },
})

try {
  await client.connect(transport)
  const resultado = await client.listTools()
  const n = resultado?.tools?.length ?? 0
  console.log(`listTools OK: ${n} tools`)
  await client.close()
  process.exit(n >= 15 ? 0 : 1)
} catch (err) {
  console.log(`listTools FAIL: ${resumo(err)}`)
  try {
    await client.close()
  } catch {
    /* já falhou; nada a fazer */
  }
  process.exit(1)
}
