# Benchmark — nosso `coroner` × MCPs de Autopsy/DFIR existentes

> Levantamento em **2026-09-17** com dados primários (GitHub API, npm, releases oficiais).
> Escopo: MCPs que expõem **Autopsy** ou **Sleuth Kit** a agentes de IA. Objetivo: saber onde
> estamos à frente, onde estamos atrás e o que isso muda no nosso roadmap.

## 1. Método

Fontes consultadas (todas públicas, consulta direta):

```bash
# busca de repositórios
curl -s "https://api.github.com/search/repositories?q=autopsy+mcp&sort=stars"
curl -s "https://api.github.com/search/repositories?q=sleuthkit+mcp"
curl -s "https://api.github.com/search/repositories?q=forensics+mcp+server"
# metadados/atividade por repo
curl -s "https://api.github.com/repos/<owner>/<repo>"
# releases oficiais do Autopsy (o que entrou em cada versão)
curl -s "https://api.github.com/repos/sleuthkit/autopsy/releases"
# lista de tools do MCP oficial (lado Java)
curl -sL "https://raw.githubusercontent.com/sleuthkit/autopsy/HEAD/Core/src/org/sleuthkit/autopsy/mcp/McpProtocolHandler.java"
# npm
curl -s "https://registry.npmjs.org/-/v1/search?text=autopsy%20mcp"
```

## 2. Panorama

| Projeto | Linguagem | ★ | Licença | Atividade | O que é |
|:--|:--|--:|:--|:--|:--|
| **Oficial — `sleuthkit/autopsy`** (`Tools/autopsy-mcp-stdio` + Java) | Java + Node wrapper | 3.355 (repo) | sem SPDX | 4.23.1 (2026-05-07) | **MCP embutido no Autopsy 4.23**, HTTP em `127.0.0.1:8765` + proxy stdio `.exe` |
| `th0r10293847/autopsy-mcp` | Python | 1 | MIT | 2026-08-07 | servidor sobre `autopsy.db` (stdio), 7 tools, suporta PostgreSQL |
| `nhantouli/AutopsyMCP` | Java | 0 | Apache-2.0 | 2026-06-04 | MCP + **plugin `.nbm` dentro do Autopsy** |
| `DeepakNarayananS/Autopsy-MCP` | (config) | 0 | MIT | 2026-05-31 | wrapper VS Code **para o bridge oficial** |
| `heejung0/sleuthkit-mcp-server` | Python | 0 | sem licença | 2025-12-08 | **TSK CLI** (`mmls/fls/ifind/icat/istat`), 8 tools, imagens **E01/RAW/VMDK** |
| Adjacentes (não-Autopsy) | — | — | — | — | Volatility-MCP (41★), volatility3-mcp (19★), Camel/SIFT (38★), winforensics-mcp (23★), Reversecore_MCP (205★), evidencegene-court (recusa estruturamente achado sem referência de evidência) |

**Leitura de mercado**: o nicho é raso — os MCPs de Autopsy de terceiros têm 0–1 ★, um deles
com 7 tools. O único concorrente sério é o **oficial**, e ele só existe a partir do **4.23.0**.

## 3. O oficial, por dentro

| Item | Detalhe (fonte: releases + README + `McpProtocolHandler.java`) |
|:--|:--|
| Desde | **4.23.0 (2026-04-15)** — “MCP over STDIO Server (Windows only)”, “Signed EXE” |
| Arquitetura | Autopsy (Java) sobe **HTTP MCP local** — a porta vem de `%LOCALAPPDATA%\autopsy\mcp\mcp-config.properties` (observado **8743**; o `DEFAULT_PORT` do wrapper também é 8743, e o README deles cita 8765); `autopsy-mcp-stdio.exe` é um **proxy fino** (“no hardcoded tool definitions”) |
| Auth | **token efêmero** em `%LOCALAPPDATA%\autopsy\mcp\mcp-token`, apagado ao fechar o case |
| Escopo | **apenas o case aberto no Autopsy rodando** (o token só existe com case aberto) |
| Plataforma | **Windows** (issue #8032 pede Linux) |
| Tools | **18** (listadas abaixo) |
| Falhas conhecidas | **#8033** parâmetros desconhecidos são **descartados em silêncio** → resposta idêntica à não-filtrada (agente recebe resposta plausível e errada); **#8038** não existe tool para **rodar** busca por palavra-chave (só vê hits já existentes) |

**Tools oficiais (18)** extraídas do Java: `get_account_relationships`, `get_case_summary`,
`get_communications_accounts`, `get_data_source_tree`, `get_file_content`, `get_hosts`,
`get_object_children`, `get_os_accounts`, `get_report_content`, `get_server_status`,
`list_reports`, `query_analysis_results`, `query_data_artifacts`, `query_data_sources`,
`query_files`, `query_tags`, `query_timeline`, `summarize_timeline`.

## 4. Nosso × oficial — cobertura

| Capacidade | Nós (21 tools) | Oficial (18) |
|:--|:--|:--|
| Casos | `list_cases`, `set_active_case` (qualquer case **em disco**) | implícito: **só o case aberto** |
| Resumo do case | `get_case_summary` | `get_case_summary` |
| Arquivos | `browse_filesystem`, `find_files`, `find_artifacts`, `get_file_metadata` | `query_files` (17 params), `get_object_children`, `query_data_sources`, `get_data_source_tree` |
| Conteúdo | `get_file_hex`, `get_file_strings`, `extract_file`, `export_evidence` | `get_file_content` |
| Artefatos | `query_blackboard_artifacts`, `find_artifacts` | `query_data_artifacts`, `query_analysis_results` |
| Timeline | `browse_timeline` | `query_timeline`, **`summarize_timeline`** |
| Keywords | **`search_keywords`, `search_keyword_hits`** | ✗ (é a issue #8038) |
| Tags | `browse_tags` | `query_tags` |
| Contas/hosts | `get_os_accounts` | `get_os_accounts`, **`get_hosts`**, **`get_communications_accounts`**, **`get_account_relationships`** |
| Conversas | `extract_conversations` | (via communications_accounts) |
| Relatórios do Autopsy | ✗ | **`list_reports`, `get_report_content`** |
| SQL read-only em DB de evidência | **`open_sqlite` (com params)** | ✗ |
| Extrato citável (JSON c/ hash+MAC) | **`export_evidence`** | ✗ |
| **Trilha de auditoria + selo** | **`verify_audit_log`, `seal_audit_log`** | ✗ |
| Status do servidor | ✗ | `get_server_status` |

## 5. Onde ganhamos, onde perdemos

### Ganhamos
1. **Cadeia de custódia de verdade** — trilha NDJSON encadeada por hash, **rotativa por case**,
   **selo** com assinatura (Ed25519/RSA-ICP-Brasil/EC) + **carimbo RFC 3161**, verificação por
   terceiro (`audit-verify`, `audit-seal --verify` com oráculo openssl, `tsa-verify`) e
   **fail-closed** (se não gravar, a tool recusa). O oficial **não tem nada disso**.
2. **Não depende do Autopsy estar aberto** — lemos qualquer `autopsy.db` em disco, o que
   habilita análise remota, por agente, fora do horário, sem GUI (o oficial exige app aberto
   com o case carregado, e o token morre ao fechar).
3. **Busca por palavra-chave que funciona** (`search_keywords`/`search_keyword_hits`) — a
   lacuna que a comunidade abriu issue pedindo (#8038).
4. **SQL read-only arbitrário** (`open_sqlite`) — foi o que destravou WhatsApp Web, Chrome e
   Edge no caso que examinamos; o oficial não expõe isso.
5. **Extrato citável** (`export_evidence`) e **disciplina de path** (recusa escrever dentro do
   case; recusa raiz não autorizada).
6. **Transporte remoto** (HTTP + túnel SSH) para agente em outra máquina; o oficial é
   stdio/local-Windows (o HTTP nativo depende do arquivo de token, que é local).
7. **Suíte de testes** — 114 testes/12 arquivos, incluindo invariância do sha256 do `autopsy.db`
   após uso (propriedade de custódia) e verificação do selo; `typecheck` e biome no pre-commit.

### Perdemos (a considerar)
1. **`get_hosts` / `get_account_relationships` / `get_communications_accounts`** — casos
   multi-host/multi-usuário; nós não temos tools explícitas para host e grafo de contas.
2. **`list_reports` / `get_report_content`** — consumir relatórios que o próprio Autopsy gerou.
3. **`summarize_timeline`** — agregação amigável ao LLM; nós devolvemos evento cru com `limit`.
4. **Token de auth no HTTP** — o oficial tem token efêmero; nós dependemos de bind em
   `127.0.0.1` + túnel (defesa por rede, não por credencial).
5. **Primeiridade** — o oficial acompanha o Autopsy, é EXE assinado e instala fácil.
6. **PostgreSQL** — o `th0r10293847/autopsy-mcp` suporta base multi-usuário; nós só SQLite.

### Empatamos
Read-only por construção, tolerância a versões de schema, mensagens de erro com dicas de
tabela/schema para o LLM se autocorrigir, sessão com “case ativo”.

## 6. Achado que é nosso problema também (P0 do nosso roadmap)

**Temos a mesma classe da falha #8033.** O `th0r` e o oficial sofrem, e nós também: nossos
schemas são `z.object({...})` e **não há um único `.strict()`** no `src/` — o zod **descarta
parâmetro desconhecido em silêncio**, então um agente que alucina `pathContains` recebe o
resultado **não filtrado** e acredita nele. Em perícia isso é grave.

Correção (nosso diferencial após corrigir): `.strict()` em **todos** os `inputSchema` +
`additionalProperties: false` no JSON Schema anunciado + **teste de regressão** que chama uma
tool com parâmetro inventado e exige **erro explícito** (não resultado silencioso).

**Status (2026-09-29): feito** — `strictSchema()` cobre as 21 tools, com regressão em
`tests/strict-input.test.js`. A mesma classe foi reportada e corrigida no MCP **oficial**:
PR [sleuthkit/autopsy#8039](https://github.com/sleuthkit/autopsy/pull/8039).

O episódio do PR acrescentou um detalhe que este benchmark não tinha visto: o wrapper de stdio
(`Tools/autopsy-mcp-stdio/autopsy-mcp-stdio.js`) **criava** o envelope `{tools}` a partir do array
que o Java devolvia. Ou seja, o `tools/list` do bridge só quebrava clientes que falassem **direto**
com o Java/HTTP (como o nosso), e consertar só o Java duplicaria o envelope
(`{"tools":{"tools":[…]}}`) e quebraria o Claude Desktop. Patch, reprodução e as duas verificações
em [`upstream/coroner-conformance/`](upstream/coroner-conformance/).

## 7. O que isso muda no roadmap

| # | Ação | Por quê | Prioridade |
|:--|:--|:--|:--:|
| 1 | `.strict()` + `additionalProperties: false` + teste | classe #8033; segurança pericial | **P0 ✅** (feito; e o equivalente upstream virou o PR #8039) |
| 2 | Token de auth opcional no transporte HTTP | paridade com o oficial; defesa por credencial além da rede | P1 |
| 3 | **Proxy do bridge oficial dentro da nossa trilha** — uma tool que encaminha ao HTTP `127.0.0.1:8743` (porta de `mcp-config.properties`; o README deles diz 8765, o default do wrapper é 8743) com o token, e **registra+sela** cada chamada | herda as 18 tools oficiais **com** a nossa custódia (o oficial não tem trilha) | P1 |
| 4 | `get_hosts`, `get_account_relationships`, `get_communications_accounts`, `list_reports`/`get_report_content`, `summarize_timeline` | fechar as lacunas de cobertura | P2 |
| 5 | **Atualizar Autopsy 4.22.1 → 4.23.1** | ganha o bridge oficial, o *“Keyword Search desligado por padrão (é lento)”* — exatamente a dor do Solr de 28 GB —, Solr Bin protocol, RegRipper v4, thumbcache, prefetch, e o aviso de EDR vs case folders | P2 ✅ (4.23.1 instalado) |
| 6 | Backend PostgreSQL (multi-usuário) | paridade com o `th0r`; casos de equipe | P3 |

**Conclusão**: no eixo “integrar o Autopsy a um agente”, o oficial nos alcançou — e ganha em
proximidade, auth e alguns tools. No eixo **perícia com validade jurídica** (trilha, selo,
carimbo, verificação por terceiro, fail-closed, extrato citável, funcionar sem GUI e remoto),
seguimos **sozinhos**. A jogada certa não é competir: é **embrulhar o bridge oficial na nossa
trilha** (item 3) — as 18 tools deles passam a ter auditoria e selo, algo que eles não têm.

## 8. Fontes

| Fonte | URL | Data |
|:--|:--|:--|
| Releases Autopsy | https://api.github.com/repos/sleuthkit/autopsy/releases | 4.23.1 = 2026-05-07; 4.23.0 = 2026-04-15 |
| Tools oficiais (Java) | `Core/src/org/sleuthkit/autopsy/mcp/McpProtocolHandler.java` | consulta 2026-09-17 |
| Proxy oficial | `Tools/autopsy-mcp-stdio/README.md`, `package.json` | consulta 2026-09-17 |
| Wrapper de stdio (Java↔Node) | `Tools/autopsy-mcp-stdio/autopsy-mcp-stdio.js` | consulta 2026-09-29; `DEFAULT_PORT = 8743`, cria o envelope `{tools}` a partir do array do Java |
| **PR #8039** (conformidade do MCP oficial) | https://github.com/sleuthkit/autopsy/pull/8039 | aberto 2026-09-29 |
| Issue #8033 (falha silenciosa) | https://github.com/sleuthkit/autopsy/issues/8033 | aberta 2026-09-09 |
| Issue #8038 (falta busca por keyword) | https://github.com/sleuthkit/autopsy/issues/8038 | aberta 2026-09-21 |
| Issue #8032 (Linux) | https://github.com/sleuthkit/autopsy/issues/8032 | aberta 2026-09-04 |
| `th0r10293847/autopsy-mcp` | https://github.com/th0r10293847/autopsy-mcp | MIT, 7 tools, pytest |
| `nhantouli/AutopsyMCP` | https://github.com/nhantouli/AutopsyMCP | Apache-2.0, plugin `.nbm` |
| `heejung0/sleuthkit-mcp-server` | https://github.com/heejung0/sleuthkit-mcp-server | TSK CLI, E01/RAW/VMDK |
