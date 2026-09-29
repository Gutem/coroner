import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { isAbsolute, relative, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import z from 'zod'
import { createAuditRouter, verifyAuditLog } from './audit.js'
import { sealAuditLog } from './seal.js'
import * as tools from './tools.js'

const VERSION = '0.1.0'

/** @param {string} msg @returns {{ content: { type: 'text', text: string }[], isError: true }} */
function errorResponse(msg) {
  return {
    content: [
      { type: /** @type {'text'} */ ('text'), text: JSON.stringify({ error: msg }, null, 2) },
    ],
    isError: true,
  }
}

/**
 * Torna a entrada estrita: parâmetro desconhecido vira ERRO explícito, nunca é
 * descartado em silêncio. É a classe da issue sleuthkit/autopsy#8033 — sem isso
 * a tool roda como se nenhum filtro tivesse sido passado e o agente recebe um
 * resultado **plausível e errado** (inaceitável em perícia).
 * @param {any} schema
 * @returns {any}
 */
function strictSchema(schema) {
  if (schema instanceof z.ZodObject) return schema.strict()
  // Só o objeto estrito NU é anunciado com `additionalProperties: false` — qualquer
  // invólucro (.optional/.default/preprocess) faz o SDK normalizar e perder o flag
  // (ou, no caso do preprocess, perder tudo). Ver tests/strict-input.test.js.
  if (schema instanceof z.ZodOptional) {
    const inner = schema.unwrap()
    if (inner instanceof z.ZodObject) return inner.strict()
  }
  return schema
}

/**
 * Cria o McpServer com todas as tools registradas para um ctx de sessão.
 * Com `ctx.env.auditLog` ligado, cada chamada vira um registro append-only
 * encadeado por hash (fail-closed: se o log não gravar, a tool falha).
 * @param {import('./ctx.js').Ctx} ctx
 * @returns {McpServer}
 */
export function createMcpServer(ctx) {
  const server = new McpServer({
    name: 'coroner',
    version: VERSION,
  })

  // roteia a trilha: se AUTOPSY_AUDIT_LOG for diretório (ou tiver {case} no nome),
  // cada case ganha seu próprio arquivo — o anexo do laudo é só o daquele exame
  const audit = ctx.env.auditLog
    ? createAuditRouter({
        target: ctx.env.auditLog,
        session: ctx.sessionId,
        caseOf: () => ctx.active,
      })
    : null

  /**
   * Executa com trilha de auditoria. Falha de log interrompe a operação.
   * @param {any} fn
   * @param {any} args
   * @param {string} toolName
   */
  const execute = (fn, args, toolName) => {
    const started = Date.now()
    let payload
    try {
      payload = fn(ctx, args ?? {})
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (audit) {
        try {
          audit.record({
            case: ctx.active,
            tool: toolName,
            args,
            ok: false,
            error: msg,
            duration_ms: Date.now() - started,
          })
        } catch (logErr) {
          return errorResponse(
            `Falha no log de auditoria: ${logErr instanceof Error ? logErr.message : String(logErr)}`
          )
        }
      }
      return errorResponse(msg)
    }
    if (audit) {
      try {
        audit.record({
          case: ctx.active,
          tool: toolName,
          args,
          ok: true,
          result: payload,
          duration_ms: Date.now() - started,
        })
      } catch (logErr) {
        return errorResponse(
          `Falha no log de auditoria (exame interrompido, fail-closed): ${logErr instanceof Error ? logErr.message : String(logErr)}`
        )
      }
    }
    return {
      content: [{ type: /** @type {'text'} */ ('text'), text: JSON.stringify(payload, null, 2) }],
    }
  }

  const n = z.number().int()
  /**
   * @param {any} name
   * @param {any} desc
   * @param {any} schema
   * @param {any} fn
   */
  const reg = (name, desc, schema, fn) => {
    server.registerTool(
      name,
      { description: desc, inputSchema: strictSchema(schema) },
      /** @param {any} args */ async args => execute(fn, args, name)
    )
  }

  reg(
    'list_cases',
    'Lista os cases do Autopsy na pasta base (subpastas contendo autopsy.db). Use primeiro para descobrir o que existe, depois set_active_case.',
    z.object({ baseDir: z.string().optional() }).optional(),
    tools.listCases
  )
  reg(
    'set_active_case',
    'Ativa um case para a sessão. Aceita a pasta do case ou o caminho do autopsy.db. Valida abrindo o banco em modo READ-ONLY.',
    z.object({ casePath: z.string() }),
    tools.setActiveCase
  )
  reg(
    'get_case_summary',
    'Resumo do case ativo: metadata, data sources, total de arquivos/artifacts e breakdown por tipo de artifact.',
    z.object({}).optional(),
    tools.getCaseSummary
  )
  reg(
    'browse_filesystem',
    'Navega a árvore tsk_files. Sem args lista as raízes (data sources). Desça com parent_obj_id (preferido) ou parent_path.',
    z
      .object({
        parentPath: z.string().optional(),
        parentObjId: n.optional(),
        dataSourceObjId: n.optional(),
        limit: n.optional(),
        offset: n.optional(),
      })
      .optional(),
    tools.browseFilesystem
  )
  reg(
    'query_blackboard_artifacts',
    'Consulta o Blackboard do Autopsy (web history, email, EXIF, chat...). Sem artifact_type lista os tipos presentes com contagens. Com artifact_type (type_name ou id) retorna os artifacts com atributos decodificados.',
    z
      .object({
        artifactType: z.string().optional(),
        dataSourceObjId: n.optional(),
        limit: n.optional(),
        offset: n.optional(),
      })
      .optional(),
    tools.queryBlackboardArtifacts
  )
  reg(
    'search_keywords',
    'Busca textual: nomes de arquivo e/ou conteúdo de artifacts. Scope: filenames, artifacts ou both.',
    z.object({
      keyword: z.string(),
      scope: z.enum(['filenames', 'artifacts', 'both']).optional(),
      limit: n.optional(),
    }),
    tools.searchKeywords
  )
  reg(
    'get_file_metadata',
    'Metadata forense completa de um arquivo (obj_id): hashes MD5/SHA-1/SHA-256, MAC times, size, MIME, status known/notable e artifacts associados.',
    z.object({ objId: n }),
    tools.getFileMetadata
  )
  reg(
    'browse_tags',
    'Lista as tags do case (marcações do analista) com contagens por tipo: arquivos, artifacts e conteúdo.',
    z.object({}).optional(),
    tools.browseTags
  )
  reg(
    'browse_timeline',
    'Linha do tempo: usa tsk_events quando existe (eventos do Autopsy com tipo/descrição) e cai para os MAC times de tsk_files. start/end em epoch seconds. order=desc traz os eventos mais recentes primeiro (evite offset alto com asc em cases grandes).',
    z
      .object({
        start: z.number().optional(),
        end: z.number().optional(),
        field: z.enum(['mtime', 'atime', 'ctime', 'crtime']).optional(),
        order: z.enum(['asc', 'desc']).optional(),
        limit: n.optional(),
        offset: n.optional(),
      })
      .optional(),
    tools.browseTimeline
  )
  reg(
    'get_os_accounts',
    'Contas de sistema operacional detectadas no case (Autopsy 4.19+).',
    z.object({}).optional(),
    tools.getOsAccounts
  )
  reg(
    'search_keyword_hits',
    'Hits do índice de keywords do Autopsy com excerpt. Sem keyword lista os hits recentes.',
    z.object({ keyword: z.string().optional(), limit: n.optional() }).optional(),
    tools.searchKeywordHits
  )
  reg(
    'get_file_hex',
    'Hex dump de um slice do conteúdo do arquivo (offset/length em bytes). Requer AUTOPSY_EXPORT_DIR ou AUTOPSY_FILES_ROOT.',
    z.object({ objId: n, path: z.string().optional(), offset: n.optional(), length: n.optional() }),
    tools.getFileHex
  )
  reg(
    'get_file_strings',
    'Strings ASCII/UTF-8 extraídas do conteúdo do arquivo. Requer AUTOPSY_EXPORT_DIR ou AUTOPSY_FILES_ROOT.',
    z.object({
      objId: n,
      path: z.string().optional(),
      minLength: n.optional(),
      limit: n.optional(),
    }),
    tools.getFileStrings
  )
  reg(
    'extract_file',
    'Copia o conteúdo do arquivo para outPath (fora do case; recusa caminhos dentro da pasta do case). Requer AUTOPSY_EXPORT_DIR ou AUTOPSY_FILES_ROOT.',
    z.object({ objId: n, path: z.string().optional(), outPath: z.string() }),
    tools.extractFile
  )
  reg(
    'find_files',
    'Busca arquivos por tipo MIME, extensão, hash (sha256/md5/sha1), status known/notable (NSRL/2=notable), tamanho, trecho de caminho e janela de mtime. Ex.: achar msgstore.db, ChatStorage.sqlite, History do Chromium; ou um hash de IOC.',
    z
      .object({
        name: z.string().optional(),
        mimeType: z.string().optional(),
        extension: z.string().optional(),
        sha256: z.string().optional(),
        md5: z.string().optional(),
        sha1: z.string().optional(),
        known: n.optional(),
        sizeMin: n.optional(),
        sizeMax: n.optional(),
        pathContains: z.string().optional(),
        after: n.optional(),
        before: n.optional(),
        limit: n.optional(),
        offset: n.optional(),
      })
      .optional(),
    tools.findFiles
  )
  reg(
    'find_artifacts',
    'Busca um termo em TODOS os atributos de artefatos (mensagens, buscas, URLs, contatos) e devolve os artefatos com todos os atributos. Filtra por term, tipo de artefato e nome de atributo.',
    z
      .object({
        term: z.string().optional(),
        artifactType: z.string().optional(),
        attributeName: z.string().optional(),
        limit: n.optional(),
        offset: n.optional(),
      })
      .optional(),
    tools.findArtifacts
  )
  reg(
    'extract_conversations',
    'Agrupa artefatos de mensagem/chat por participante (telefone/contato) com corpo, direção e horário, ordenado por tempo. Triagem de conversas — ex.: checar contato com suspeito. Filtra por participant e janela from/to (epoch).',
    z
      .object({
        participant: z.string().optional(),
        from: n.optional(),
        to: n.optional(),
        limit: n.optional(),
      })
      .optional(),
    tools.extractConversations
  )
  reg(
    'open_sqlite',
    'Abre um SQLite de dentro da imagem (msgstore.db do WhatsApp, ChatStorage.sqlite do iOS, History do Chromium...) e roda um SELECT read-only. Use params para valores vinculados (?). Requer AUTOPSY_EXPORT_DIR ou AUTOPSY_FILES_ROOT. Use find_files para achar o obj_id do banco.',
    z.object({
      objId: n,
      path: z.string().optional(),
      sql: z.string(),
      params: z.array(z.union([z.string(), z.number()])).optional(),
      limit: n.optional(),
    }),
    tools.openSqlite
  )
  reg(
    'export_evidence',
    'Gera um extrato JSON citável (metadados, hashes, MAC times e artefatos) dos obj_ids/artifact_ids informados, para anexar ao laudo. Escreve sempre fora da pasta do case.',
    z.object({
      objIds: z.array(n).optional(),
      artifactIds: z.array(n).optional(),
      outPath: z.string(),
    }),
    tools.exportEvidence
  )
  server.registerTool(
    'verify_audit_log',
    {
      description:
        'Verifica a integridade do log de auditoria (cadeia de hash: detecta registro editado, removido ou reordenado). Use para comprovar a trilha do exame — inclusive um terceiro pode rodar. Requer AUTOPSY_AUDIT_LOG configurado.',
      inputSchema: strictSchema(z.object({}).optional()),
    },
    async () => {
      if (!ctx.env.auditLog) {
        return errorResponse(
          'Log de auditoria desabilitado: configure AUTOPSY_AUDIT_LOG (caminho fora do case) para habilitar.'
        )
      }
      const result = verifyAuditLog(audit ? audit.currentPath() : ctx.env.auditLog)
      if (audit) {
        try {
          audit.record({
            case: ctx.active,
            tool: 'verify_audit_log',
            args: {},
            ok: result.ok,
            result,
          })
        } catch (logErr) {
          return errorResponse(
            `Falha ao registrar a verificação no log: ${logErr instanceof Error ? logErr.message : String(logErr)}`
          )
        }
      }
      return {
        content: [{ type: /** @type {'text'} */ ('text'), text: JSON.stringify(result, null, 2) }],
      }
    }
  )

  server.registerTool(
    'seal_audit_log',
    {
      description:
        'Sela a trilha de auditoria: SHA-256 do log + verificação da cadeia + arquivamento opcional + assinatura (Ed25519, RSA/ICP-Brasil ou EC) + carimbo de tempo RFC 3161 (se AUTOPSY_TSA_URL). Gera o JSON do selo para anexar ao laudo; escreva sempre fora do case. Registra o próprio ato de selar ANTES de selar, então o selo cobre esse registro — qualquer registro novo depois invalida o selo (refaça o selo).',
      inputSchema: strictSchema(
        z.object({
          outPath: z.string(),
          archivePath: z.string().optional(),
        })
      ),
    },
    /** @param {any} args */
    async args => {
      if (!ctx.env.auditLog) {
        return errorResponse('Trilha desabilitada: configure AUTOPSY_AUDIT_LOG para poder selar.')
      }
      try {
        if (ctx.active.caseDir && isInsideCaseDir(ctx.active.caseDir, args.outPath)) {
          return errorResponse(
            'outPath está dentro da pasta do case — recusado (o selo é produto do exame, não pode ir para o case).'
          )
        }
        // 1) registra o ato de selar (o selo passa a cobrir este registro)
        if (audit) {
          audit.record({
            case: ctx.active,
            tool: 'seal_audit_log',
            args: { outPath: args.outPath, archivePath: args.archivePath ?? null },
            ok: true,
            result: { status: 'sealing' },
          })
        }
        // 2) sela
        const seal = await sealAuditLog({
          logPath: audit ? audit.currentPath() : ctx.env.auditLog,
          outPath: args.outPath,
          archivePath: args.archivePath ?? null,
          tsaUrl: ctx.env.tsaUrl ?? null,
          privateKeyPem: ctx.env.sealKeyFile ? readFileSync(ctx.env.sealKeyFile, 'utf8') : null,
          certificatePem: ctx.env.sealCertFile ? readFileSync(ctx.env.sealCertFile, 'utf8') : null,
        })
        return {
          content: [{ type: /** @type {'text'} */ ('text'), text: JSON.stringify(seal, null, 2) }],
        }
      } catch (e) {
        return errorResponse(e instanceof Error ? e.message : String(e))
      }
    }
  )

  return server
}

/**
 * @param {string} caseDir
 * @param {string} candidate
 */
function isInsideCaseDir(caseDir, candidate) {
  const rel = relative(resolve(caseDir), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Serve via stdio (agente local: opencode, Claude Desktop, Cline).
 * @param {import('./ctx.js').Ctx} ctx
 */
export async function serveStdio(ctx) {
  const server = createMcpServer(ctx)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[coroner] stdio READ-ONLY server ativo')
}

/**
 * Serve via HTTP (agente remoto). Cada sessão MCP tem seu próprio ctx.
 * @param {() => import('./ctx.js').Ctx} makeCtx - fábrica de ctx por sessão
 * @param {{ host?: string, port?: number }} opts
 */
export function serveHttp(makeCtx, opts = {}) {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 3123
  /** @type {Map<string, StreamableHTTPServerTransport>} */
  const sessions = new Map()
  /** @type {Map<string, McpServer>} */
  const servers = new Map()

  const http = createServer(async (req, res) => {
    const sessionId = /** @type {string | undefined} */ (req.headers['mcp-session-id'])
    if (sessionId && sessions.has(sessionId)) {
      const tx = sessions.get(sessionId)
      if (tx) await tx.handleRequest(req, res)
      return
    }
    if (!sessionId) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => {
          sessions.set(id, transport)
          servers.set(id, server)
        },
      })
      const server = createMcpServer(makeCtx())
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId)
          servers.delete(transport.sessionId)
        }
      }
      await server.connect(transport)
      await transport.handleRequest(req, res)
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: null,
      })
    )
  })

  http.listen(port, host, () => {
    console.error(`[coroner] HTTP READ-ONLY server em http://${host}:${port}/mcp`)
  })
  return http
}
