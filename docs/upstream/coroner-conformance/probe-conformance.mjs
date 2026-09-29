#!/usr/bin/env node
/**
 * Conformance probe for an MCP server's `tools/list` response.
 *
 * Why not just use the official SDK? Because a spec-validating client *throws* on a malformed
 * response (that is the point), which makes it useless as a diagnostic: you need a probe that
 * reports WHAT is wrong, not one that dies. This speaks raw JSON-RPC over HTTP and checks the
 * response against the MCP schema by hand.
 *
 * Usage:
 *   node probe-conformance.mjs --url http://127.0.0.1:8743/mcp --token <bearer> [flags]
 *
 * Flags:
 *   --token-file <path>                 read the bearer token from a file (e.g. Autopsy's mcp-token)
 *   --require-additional-properties     treat a missing/false `additionalProperties` as a violation
 *
 * Exit codes: 0 = conformant, 1 = violations found, 2 = usage/connection error.
 *
 * Checks (MCP schema 2024-11-05 / 2025-06-18 / 2025-11-25 all agree):
 *   1. `result` is an OBJECT (ListToolsResult), not an array
 *   2. `result.tools` is a non-empty array
 *   3. every tool has a name (string) and an `inputSchema` with type "object" and `properties`
 *   4. optionally: `inputSchema.additionalProperties === false`
 */
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const opt = name => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}

const url = opt('--url')
const tokenFile = opt('--token-file')
const requireAdditional = flag('--require-additional-properties')
let token = opt('--token')

if (!url) {
  console.error(
    'uso: node probe-conformance.mjs --url <mcp-url> [--token <bearer> | --token-file <path>]'
  )
  process.exit(2)
}
if (!token && tokenFile) {
  try {
    token = readFileSync(tokenFile, 'utf8').trim()
  } catch (e) {
    console.error(`não li o token em ${tokenFile}: ${e.message}`)
    process.exit(2)
  }
}

/** @param {unknown} body @returns {any} */
function parseMaybeSse(body) {
  const text = String(body)
  // Streamable HTTP may answer as JSON or as Server-Sent Events; take the first data: payload.
  if (text.trimStart().startsWith('{')) return JSON.parse(text)
  const line = text.split(/\r?\n/).find(l => l.startsWith('data:'))
  if (!line) throw new Error(`resposta não é JSON nem SSE: ${text.slice(0, 120)}`)
  return JSON.parse(line.slice(5).trim())
}

const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
}

async function rpc(method, params = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 160)}`)
  return parseMaybeSse(body)
}

/** @type {string[]} */
const problems = []

try {
  await rpc('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'probe-conformance', version: '1.0.0' },
  })

  const response = await rpc('tools/list')
  if (response.error) throw new Error(`tools/list devolveu erro: ${JSON.stringify(response.error)}`)

  const result = response.result
  if (Array.isArray(result)) {
    problems.push(
      'tools/list: "result" é um ARRAY — a spec exige ListToolsResult (objeto) com "tools": Tool[]. ' +
        'Cliente conforme falha ao validar (ZodError: expected object, received array).'
    )
  } else if (typeof result !== 'object' || result === null) {
    problems.push(`tools/list: "result" deveria ser um objeto, veio ${typeof result}`)
  }

  const tools = Array.isArray(result) ? result : result?.tools
  if (!Array.isArray(tools)) {
    problems.push('tools/list: "result.tools" ausente ou não é array')
  } else if (tools.length === 0) {
    problems.push('tools/list: "result.tools" está vazio')
  } else {
    for (const tool of tools) {
      const name = tool?.name ?? '(sem nome)'
      if (typeof tool?.name !== 'string') problems.push(`tool ${name}: "name" ausente/não string`)
      const schema = tool?.inputSchema
      if (!schema) {
        problems.push(`tool ${name}: "inputSchema" ausente (a spec exige um JSON Schema)`)
        continue
      }
      if (schema.type !== 'object')
        problems.push(`tool ${name}: inputSchema.type="${schema.type}" (esperado "object")`)
      if (!schema.properties || typeof schema.properties !== 'object') {
        problems.push(
          `tool ${name}: inputSchema.properties ausente (a spec exige os parâmetros esperados)`
        )
      }
      if (requireAdditional && schema.additionalProperties !== false) {
        problems.push(
          `tool ${name}: additionalProperties=${JSON.stringify(schema.additionalProperties)} — ` +
            'a spec recomenda false; parâmetro desconhecido fica silenciosamente ignorado (issue #8033)'
        )
      }
    }
  }
} catch (e) {
  console.error(`FALHA DE CONEXÃO/PROTOCOLO: ${e.message}`)
  process.exit(2)
}

if (problems.length) {
  console.log(`NÃO CONFORME — ${problems.length} violação(ões):`)
  for (const p of problems) console.log(`  ✗ ${p}`)
  process.exit(1)
}

console.log(
  'CONFORME: envelope de tools/list e schemas das tools estão de acordo com a spec do MCP.'
)
process.exit(0)
