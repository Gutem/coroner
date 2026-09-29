import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { makeCase } from './fixtures/make-case.js'

const { serveHttp } = await import('../src/server.js')
const { createCtx } = await import('../src/ctx.js')

describe('transporte HTTP — agente remoto', () => {
  /** @type {import('node:http').Server} */ let http
  /** @type {Client} */ let client
  /** @type {string} */ let dir

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'coroner-'))
    const { caseDir } = makeCase(dir)
    http = serveHttp(
      () => {
        const ctx = createCtx({ casesDir: dir, exportDir: null, filesRoot: null })
        ctx.setActiveCase(caseDir)
        return ctx
      },
      { host: '127.0.0.1', port: 0 }
    )
    await /** @type {Promise<void>} */ (
      new Promise(resolve => {
        const id = setInterval(() => {
          if (http.listening) {
            clearInterval(id)
            resolve()
          }
        }, 10)
      })
    )
    const port = /** @type {any} */ (http.address()).port
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    client = new Client({ name: 'remote-test', version: '0.0.0' })
    await client.connect(transport)
  })

  afterAll(async () => {
    await client.close()
    http.close()
  })

  test('sessão HTTP completa: list_tools e call_tool', async () => {
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).toContain('list_cases')

    const r = await client.callTool({ name: 'get_case_summary', arguments: {} })
    const text = /** @type {any[]} */ (r.content).find(c => c.type === 'text')
    const payload = JSON.parse(text.text)
    expect(payload.case).toBe('Caso-Teste')
    expect(payload.total_files).toBe(4)
  })

  test('segunda sessão tem case ativo próprio (isolamento)', async () => {
    const port = /** @type {any} */ (http.address()).port
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    const client2 = new Client({ name: 'remote-test-2', version: '0.0.0' })
    await client2.connect(transport)
    const r = await client2.callTool({ name: 'get_case_summary', arguments: {} })
    const text = /** @type {any[]} */ (r.content).find(c => c.type === 'text')
    const payload = JSON.parse(text.text)
    // cada sessão ganha um ctx novo; o case ativo foi setado pela fábrica
    expect(payload.total_files).toBe(4)
    await client2.close()
  })
})
