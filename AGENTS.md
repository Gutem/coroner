# AGENTS.md — coroner

> **Global rules**: `~/.config/opencode/AGENTS.md`
> **Template**: `~/code/template-backend`

## Project

MCP server read-only para casos forenses do Autopsy. Lê `autopsy.db` (SQLite via `bun:sqlite`, driver readonly) e expõe 21 tools MCP para agentes de IA: case/filesystem, blackboard artifacts, keywords, tags, timeline, contas de OS, conteúdo (hex/strings/extract), triagem investigativa (`find_*`, `open_sqlite`, `export_evidence`) e perícia (`verify_audit_log`, `seal_audit_log`). Transportes stdio (agente local) e HTTP (agente remoto).

## Architecture / Conventions

- **Runtime**: Bun | **JS vanilla + JSDoc** | **Tests**: `bun test` (TDD obrigatório)
- `src/db.js` — wrapper readonly do bun:sqlite + erros auto-explicativos pro LLM (hints de schema/tabelas)
- `src/schema.js` — mapas de decodificação do schema TSK/Autopsy
- `src/tools.js` — tools puras (recebem ctx + args, retornam objeto JSON); sem dependência do protocolo
- `src/ctx.js` — contexto (case ativo, export dir) compartilhado pelas tools
- `src/content.js` — leitura de conteúdo (hex/strings/extract) via índice lazy sha256→path
- `src/audit.js` — trilha NDJSON com encadeamento de hash, rotativa por case, fail-closed
- `src/seal.js` — selo do encerramento (hash, arquivamento, assinatura Ed25519/RSA/EC, certificado ICP-Brasil) — `src/tsa.js` faz o carimbo RFC 3161
- `src/server.js` — camada MCP: registra tools, serve stdio/HTTP. **Toda tool passa por `strictSchema()`**: `additionalProperties: false` + erro explícito nomeando a chave desconhecida (classe #8033 — nunca rodar sem o filtro por engano)
- `scripts/` — CLIs de terceiro para verificar: `audit-verify.mjs`, `audit-seal.mjs`, `tsa-verify.mjs`
- **Cadeia de custódia**: nunca abre o DB em modo escrita; testes verificam invariância do sha256 do `autopsy.db` após rodar todas as tools
- Content tools só leem de `AUTOPSY_EXPORT_DIR`/`AUTOPSY_FILES_ROOT` — nunca escrevem dentro do case
- Env vars: ver `.env.example`

## Docs do projeto

- `docs/pericia/` — template de laudo, ficha de custódia, checklist de validade
- `docs/benchmark-mcps-autopsy.md` — nosso MCP × os de Autopsy/DFIR (com fontes e roadmap)
- `docs/upstream/coroner-conformance/` — pacote de conformidade do MCP **oficial** (PR #8039):
  patch, `ISSUE.md`, sonda `probe-conformance.mjs` e as verificações `verify/run.sh` (JUnit) e
  `verify/run-wrapper.sh` (wrapper de stdio + cliente do SDK). Ao mexer no patch, rode as duas.

## Histórico e commits

- Cada mudança entra como **commit próprio** — sem `--amend` nem `--force` depois que o repo foi
  publicado.
- O repo público (`coroner`) nasceu com **um** commit inicial: aquele é o estado inicial por
  construção. Daí em diante, histórico incremental normal.

## Common Tasks

### Adicionar tool
1. Implementar função pura em `src/tools.js`
2. Registrar em `src/server.js` com `strictSchema(z.object({...}))` + description rica (o LLM depende dela; o schema estrito garante o erro em parâmetro desconhecido)
3. Teste em `tests/tools.test.js` (ou no teste do módulo correspondente) + fixture em `tests/fixtures/make-case.js`
4. `bun test` verde → `bun run lint` → `bun run typecheck`
