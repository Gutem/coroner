import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { makeCase } from './fixtures/make-case.js'

const { createMcpServer } = await import('../src/server.js')
const { createCtx } = await import('../src/ctx.js')

describe('protocolo MCP — sessão completa', () => {
  /** @type {string} */ let dir
  /** @type {Client} */ let client

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'coroner-'))
    const { caseDir } = makeCase(dir)
    const ctx = createCtx({ casesDir: dir, exportDir: null, filesRoot: null })
    ctx.setActiveCase(caseDir)
    const server = createMcpServer(ctx)
    const [c, s] = InMemoryTransport.createLinkedPair()
    await server.connect(c)
    client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(s)
  })

  afterAll(async () => {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('lista as tools registradas', async () => {
    const r = await client.listTools()
    const names = r.tools.map(t => t.name)
    for (const expected of [
      'list_cases',
      'set_active_case',
      'get_case_summary',
      'browse_filesystem',
      'query_blackboard_artifacts',
      'search_keywords',
      'get_file_metadata',
      'browse_tags',
      'browse_timeline',
      'get_os_accounts',
      'search_keyword_hits',
      'get_file_hex',
      'get_file_strings',
      'extract_file',
    ]) {
      expect(names).toContain(expected)
    }
  })

  test('callTool retorna JSON válido com resultado da tool', async () => {
    const r = await client.callTool({ name: 'get_case_summary', arguments: {} })
    const text = /** @type {any[]} */ (r.content).find(c => c.type === 'text')
    const payload = JSON.parse(text.text)
    expect(payload.total_files).toBe(4)
  })

  test('erro de tool vira JSON {error} legível pro LLM', async () => {
    const r = await client.callTool({ name: 'get_file_metadata', arguments: { objId: 99999 } })
    const text = /** @type {any[]} */ (r.content).find(c => c.type === 'text')
    const payload = JSON.parse(text.text)
    expect(payload.error).toMatch(/obj_id|tsk_files/i)
  })
})
