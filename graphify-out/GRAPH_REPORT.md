# Graph Report - autopsy-mcp  (2026-09-29)

## Corpus Check
- 43 files · ~38,584 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 499 nodes · 683 edges · 35 communities
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `095b5599`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]

## God Nodes (most connected - your core abstractions)
1. `ok()` - 20 edges
2. `connectCase()` - 17 edges
3. `coroner` - 13 edges
4. `makeCase()` - 12 edges
5. `coroner` - 12 edges
6. `Laudo pericial — template` - 11 edges
7. `coroner` - 11 edges
8. `sealAuditLog()` - 10 edges
9. `Cadeia de custódia — ficha e tabela de hashes` - 10 edges
10. `withContent()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `connect()` --calls--> `createMcpServer()`  [INFERRED]
  tests/audit-server.test.js → src/server.js
- `setup()` --calls--> `createCtx()`  [INFERRED]
  tests/tools.test.js → src/ctx.js
- `makeLog()` --calls--> `createAuditLog()`  [INFERRED]
  tests/seal.test.js → src/audit.js
- `cria()` --calls--> `createAuditRouter()`  [INFERRED]
  tests/audit.test.js → src/audit.js
- `setup()` --calls--> `createCtx()`  [INFERRED]
  tests/analysis.test.js → src/ctx.js

## Communities (35 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.08
Nodes (53): buildNameIndex(), buildShaIndex(), candidatesFor(), copyTo(), exportRoots(), extractStrings(), getIndex(), isInside() (+45 more)

### Community 1 - "Community 1"
Cohesion: 0.1
Nodes (32): argv, keyPath, opensslOracle(), opts, positional, argv, opts, result (+24 more)

### Community 2 - "Community 2"
Cohesion: 0.11
Nodes (17): result, AUDIT_GENESIS, auditPathFor(), createAuditLog(), createAuditRouter(), resolveAuditTarget(), sanitizeCaseLabel(), env (+9 more)

### Community 3 - "Community 3"
Cohesion: 0.08
Nodes (24): Autopsy version compatibility, Chain of custody, code:bash (bun install), code:json ({), code:bash (# copy the case folder (or mount the image read-only) and po), code:ini (# ~/.config/systemd/user/autopsy-tunnel.service), code:bash (systemctl --user daemon-reload && systemctl --user enable --), code:bash (AUTOPSY_AUDIT_LOG=/path/outside-the-case/audit.ndjson bun ru) (+16 more)

### Community 4 - "Community 4"
Cohesion: 0.08
Nodes (21): a, archDir, archFora, archivePath, b, bad, cli, id (+13 more)

### Community 5 - "Community 5"
Cohesion: 0.13
Nodes (23): Agente remoto (Windows com Autopsy + agente no Mac/Linux), coroner, Cadeia de custódia, Camada de análise (triagem investigativa), code:bash (bun install), code:json ({), code:bash (# 1. na máquina do Autopsy: sobe o HTTP em localhost), code:powershell ($action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argume) (+15 more)

### Community 6 - "Community 6"
Cohesion: 0.11
Nodes (20): Assinatura com ICP-Brasil (não repúdio), Cadeia de custódia — ficha e tabela de hashes, code:powershell (# Windows — hash de arquivo), code:bash (# macOS/Linux), code:bash (# Trilha de auditoria do servidor MCP (verificação independe), code:block4 (C:\code\audit\trilhas\), code:bash (# 1) extraia a chave e a cadeia do seu .p12 (a senha NÃO vai), code:bash (# 1) cadeia de hashes da trilha (não depende de chave nenhum) (+12 more)

### Community 7 - "Community 7"
Cohesion: 0.1
Nodes (19): code:bash (TOKEN=$(cat "$LOCALAPPDATA/autopsy/mcp/mcp-token")   # or re), code:json ({"jsonrpc":"2.0","id":2,"result":[{"name":"get_server_status), code:json ({"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"get_serv), code:js (const t = new StreamableHTTPClientTransport(new URL('http://), code:block5 (invalid_union → [ { expected: 'object', code: 'invalid_type'), code:ts (// 2024-11-05, 2025-06-18 and 2025-11-25 — schema.ts, identi), code:bash (node probe-conformance.mjs --url http://127.0.0.1:8743/mcp -), code:block8 (run 1 — upstream code : Tests run: 2,  Failures: 2   (Assert) (+11 more)

### Community 8 - "Community 8"
Cohesion: 0.1
Nodes (19): code:bash (TOKEN=$(cat "$LOCALAPPDATA/autopsy/mcp/mcp-token")   # or re), code:json ({"jsonrpc":"2.0","id":2,"result":[{"name":"get_server_status), code:json ({"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"get_serv), code:js (const t = new StreamableHTTPClientTransport(new URL('http://), code:block5 (invalid_union → [ { expected: 'object', code: 'invalid_type'), code:ts (// 2024-11-05, 2025-06-18 and 2025-11-25 — schema.ts, identi), code:bash (node probe-conformance.mjs --url http://127.0.0.1:8743/mcp -), code:block8 (run 1 — upstream code : Tests run: 2,  Failures: 2   (Assert) (+11 more)

### Community 9 - "Community 9"
Cohesion: 0.12
Nodes (14): bom, { caseDir }, ctx, db, dir, dir2, { dir: exportDir }, exportDir (+6 more)

### Community 10 - "Community 10"
Cohesion: 0.13
Nodes (14): app, byHash, db, dbPath, escolhido, exportDir, notable, notDb (+6 more)

### Community 11 - "Community 11"
Cohesion: 0.13
Nodes (14): a, alvo, b, caseDir, doCaso, first, lines, log (+6 more)

### Community 12 - "Community 12"
Cohesion: 0.21
Nodes (14): 1. Método, 2. Panorama, 3. O oficial, por dentro, 4. Nosso × oficial — cobertura, 5. Onde ganhamos, onde perdemos, 6. Achado que é nosso problema também (P0 do nosso roadmap), 7. O que isso muda no roadmap, 8. Fontes (+6 more)

### Community 13 - "Community 13"
Cohesion: 0.14
Nodes (13): alice, anon, { caseDir }, ctx, dir, fs, nivel1, nivel2 (+5 more)

### Community 14 - "Community 14"
Cohesion: 0.14
Nodes (13): 1. Windows: OpenSSH Server, 2. Windows: server MCP como serviço, 3. Máquina do agente: túnel, 4. Agente, code:powershell (choco install openssh -y --params "/SSHServerFeature"    # P), code:block2 (AuthorizedKeysFile	.ssh/authorized_keys), code:powershell ($key = 'ssh-ed25519 AAAA... usuario@origem'), code:powershell (# PS admin, no clone do repo) (+5 more)

### Community 15 - "Community 15"
Cohesion: 0.16
Nodes (12): code:bash (./run.sh              # usa um diretório temporário), code:block2 (== 3/5 rodada 1: árvore UPSTREAM (deve falhar) ==), code:bash (./run-wrapper.sh              # diretório temporário), code:block4 (== 4/5 rodada 1: wrapper UPSTREAM (deve falhar) ==), Como rodar, Lado Java — `./run.sh`, Lado JS — `./run-wrapper.sh`, O que esta verificação NÃO cobre (+4 more)

### Community 16 - "Community 16"
Cohesion: 0.15
Nodes (12): 10. Encerramento, 1. Identificação, 2. Objeto (material examinado), 3. Cadeia de custódia, 4. Metodologia e ferramentas, 5. Exames realizados, 6. Achados, 7. Limitações e ressalvas (+4 more)

### Community 17 - "Community 17"
Cohesion: 0.17
Nodes (11): arquivos, auditDir, bad, { caseDir }, lines, out, payload, rec (+3 more)

### Community 18 - "Community 18"
Cohesion: 0.18
Nodes (9): argv, headers, parseMaybeSse(), problems, requireAdditional, rpc(), token, tokenFile (+1 more)

### Community 19 - "Community 19"
Cohesion: 0.18
Nodes (9): argv, headers, parseMaybeSse(), problems, requireAdditional, rpc(), token, tokenFile (+1 more)

### Community 20 - "Community 20"
Cohesion: 0.24
Nodes (9): makeCase(), createCtx(), setup(), ctx, ctx2, r, r2, setup() (+1 more)

### Community 21 - "Community 21"
Cohesion: 0.25
Nodes (7): [c, s], { caseDir }, ctx, names, payload, server, text

### Community 22 - "Community 22"
Cohesion: 0.25
Nodes (7): { caseDir }, client2, ctx, id, payload, text, transport

### Community 23 - "Community 23"
Cohesion: 0.46
Nodes (6): extrair(), extrair_teste(), gerar_stub(), main(), Extrai o arquivo de teste novo de dentro do patch (linhas iniciadas por '+')., Devolve o método (assinatura + corpo) a partir da assinatura dada.

### Community 24 - "Community 24"
Cohesion: 0.39
Nodes (7): Adicionar tool, AGENTS.md — coroner, AGENTS.md — coroner, Architecture / Conventions, Common Tasks, Docs do projeto, Project

### Community 25 - "Community 25"
Cohesion: 0.48
Nodes (5): client, falhar(), resumo(), transport, [wrapper, lappdata]

### Community 26 - "Community 26"
Cohesion: 0.33
Nodes (5): [c, s], { caseDir }, ctx, frouxos, server

### Community 27 - "Community 27"
Cohesion: 0.4
Nodes (4): makeExportedFiles(), makeLegacyCase(), sha256Of(), hashAfter

### Community 28 - "Community 28"
Cohesion: 0.33
Nodes (5): found, LOG, r, t, TOKEN

### Community 29 - "Community 29"
Cohesion: 0.53
Nodes (4): NOMES, port, servidor, TOOLS

### Community 30 - "Community 30"
Cohesion: 0.33
Nodes (5): Antes do exame, Checklist de validade — antes / durante / depois, Depois do exame, Durante o exame, Se algo falhar

### Community 31 - "Community 31"
Cohesion: 0.4
Nodes (4): Added, Changelog, Fixed, [Unreleased]

### Community 32 - "Community 32"
Cohesion: 0.5
Nodes (3): h, lock, rows

## Knowledge Gaps
- **250 isolated node(s):** `r`, `ctx2`, `t`, `r2`, `ctx` (+245 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `connect()` connect `Community 2` to `Community 17`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **Why does `createCtx()` connect `Community 20` to `Community 0`, `Community 2`?**
  _High betweenness centrality (0.061) - this node is a cross-community bridge._
- **What connects `r`, `ctx2`, `t` to the rest of the system?**
  _250 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.11 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._