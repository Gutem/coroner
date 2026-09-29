/**
 * Stub do MCP HTTP do Autopsy (o "lado Java") para verificar o wrapper de stdio sem o Autopsy.
 *
 * Emula o comportamento PÓS-PATCH: `tools/list` devolve um ListToolsResult de verdade --
 * `{"result": {"tools": [...]}}` -- que é o formato que o patch passa a produzir. É justamente
 * esse formato que quebra um wrapper que ainda espera um array e envelopa de novo.
 *
 * Uso: node stub-java-mcp.mjs <porta>
 * Saída: "stub on <porta>" (stdout) — o chamador usa isso como sinal de vida.
 */
import * as http from 'node:http'

const port = Number(process.argv[2])
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('uso: node stub-java-mcp.mjs <porta>')
  process.exit(2)
}

const NOMES = [
  'get_case_summary',
  'query_files',
  'get_object_children',
  'query_data_sources',
  'get_data_source_tree',
  'get_file_content',
  'query_data_artifacts',
  'query_analysis_results',
  'query_timeline',
  'summarize_timeline',
  'query_tags',
  'get_os_accounts',
  'get_hosts',
  'get_communications_accounts',
  'get_account_relationships',
  'list_reports',
  'get_report_content',
  'get_server_status',
]

const TOOLS = NOMES.map(name => ({
  name,
  description: `${name} (stub de verificação)`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}))

const servidor = http.createServer((req, res) => {
  let corpo = ''
  req.on('data', c => {
    corpo += c
  })
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')

    // o servidor real exige o Bearer token; o stub também, para não mascarar regressão
    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith('Bearer ') || auth.length <= 'Bearer '.length) {
      res.statusCode = 401
      res.end(JSON.stringify({ error: 'missing token' }))
      return
    }

    let rpc
    try {
      rpc = JSON.parse(corpo || '{}')
    } catch {
      res.statusCode = 400
      res.end(JSON.stringify({ error: 'bad json' }))
      return
    }

    const id = rpc.id ?? null
    if (rpc.method === 'tools/list') {
      // ListToolsResult: o objeto com o array -- o formato que o patch introduz no Java
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: TOOLS } }))
      return
    }
    if (rpc.method === 'tools/call') {
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify({ caseName: 'stub-case' }) }] },
        })
      )
      return
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }))
  })
})

servidor.listen(port, '127.0.0.1', () => {
  console.log(`stub on ${port}`)
})
