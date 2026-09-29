# coroner

MCP server **read-only** para cases forenses do [Autopsy](https://www.autopsy.com/). Expõe o `autopsy.db` como tools MCP para agentes de IA (opencode, Claude Desktop, Cline), preservando a cadeia de custódia: nenhuma escrita é possível no nível do driver.

- **Runtime**: Bun (SQLite nativo, zero deps pesadas) | JS vanilla + JSDoc
- **Transportes**: stdio (agente local) e HTTP (agente em outra máquina, air-gapped)
- **21 tools**: case/filesystem, blackboard, keywords, tags, timeline, contas de SO, conteúdo
  (hex/strings/extract), triagem investigativa (`find_*`, `open_sqlite`, `export_evidence`) e
  perícia (`verify_audit_log`, `seal_audit_log`)
- **Read-only e fail-closed**: o driver rejeita escrita, e parâmetro desconhecido numa tool vira
  **erro explícito** (`additionalProperties: false`, nomeando a chave) em vez de rodar sem o filtro

## Quick start

```bash
bun install
cp .env.example .env   # ajuste AUTOPSY_CASES_DIR
bun run start          # stdio — rode a partir do cliente MCP, não direto no terminal
# ou HTTP (agente remoto):
bun run src/index.js --transport http --port 3123
```

Windows: `start.bat` (stdio) ou `start.bat http 3123`.

## Conectar um agente

**opencode** (local): copie `opencode.json.example` para o seu `opencode.json` — a chave é `mcp`
(minúsculo), não `mcpServers`:

```json
{
  "mcp": {
    "autopsy": {
      "type": "local",
      "command": ["bun", "run", "/caminho/absoluto/coroner/src/index.js"],
      "environment": { "AUTOPSY_CASES_DIR": "~/AutopsyCases" },
      "enabled": true
    }
  }
}
```

**Claude Desktop** (Windows, máquina do Autopsy): use `claude_desktop_config.json.example`.
**Agente remoto**: aponte o cliente para `http://<ip-da-maquina>:3123/mcp` — o
`opencode.json.example` já traz o bloco `autopsy-remote` pronto para descomentar.

## Tools

| Tool | Descrição |
|:--|:--|
| `list_cases` | Cases na pasta base (pastas com `autopsy.db`) |
| `set_active_case` | Ativa um case (valida abrindo read-only) |
| `get_case_summary` | Metadata, data sources, contagens, breakdown de artifacts |
| `browse_filesystem` | Árvore `tsk_files` (raízes → dirs → arquivos, paginado) |
| `query_blackboard_artifacts` | Blackboard por tipo (web history, email, EXIF, chat...) |
| `search_keywords` | Busca em nomes de arquivo e/ou conteúdo de artifacts |
| `get_file_metadata` | Hashes MD5/SHA-1/SHA-256, MAC times, known status |
| `browse_tags` | Tags do analista com contagens por tipo |
| `browse_timeline` | Eventos de MAC time numa janela de datas |
| `get_os_accounts` | Contas de SO detectadas (Autopsy 4.19+) |
| `search_keyword_hits` | Hits do índice de keywords com excerpt |
| `get_file_hex` | Hex dump de slice do conteúdo |
| `get_file_strings` | Strings ASCII/UTF-8 do conteúdo |
| `extract_file` | Copia conteúdo para fora do case |

### Camada de análise (triagem investigativa)

| Tool | Descrição |
|:--|:--|
| `find_files` | Filtra por MIME, extensão, hash (sha256/md5/sha1), `known`, tamanho, trecho de caminho e janela de mtime — acha `msgstore.db`, `ChatStorage.sqlite`, `History` do Chromium, ou um hash de IOC |
| `find_artifacts` | Busca um termo em **todos** os atributos de artefatos (mensagens, buscas, URLs, contatos) e devolve o artefato completo |
| `extract_conversations` | Agrupa mensagens/chat por participante com corpo, direção e horário, ordenado por tempo |
| `open_sqlite` | Abre um SQLite **de dentro da imagem** (WhatsApp, navegador, iOS) e roda SELECT read-only |
| `export_evidence` | Gera extrato JSON citável (hashes, MAC times, artefatos) para o laudo — sempre fora do case |

`open_sqlite` é o atalho para o que mais importa numa triagem: os dados de WhatsApp (`msgstore.db`) e de navegação (`History`) são SQLite; com o conteúdo acessível (Export/mount) dá para consultar as tabelas na fonte (`message`, `chat`, `jid`, `urls`, `keyword_search_terms`).

### Perícia (trilha de auditoria e selo)

| Tool | Descrição |
|:--|:--|
| `verify_audit_log` | Verifica a cadeia de hash da trilha (detecta registro editado, removido ou reordenado) — um terceiro pode rodar |
| `seal_audit_log` | Sela o encerramento: SHA-256 do log + verificação da cadeia + arquivamento + assinatura + carimbo RFC 3161, gerando o JSON do selo |

Detalhes, env vars e os CLIs equivalentes em [Perícia: trilha de auditoria e documentos](#perícia-trilha-de-auditoria-e-documentos).

## Conteúdo de arquivos (hex/strings/extract)

As tools de conteúdo (`get_file_hex`, `get_file_strings`, `extract_file`) não leem o conteúdo do
`autopsy.db` (o Autopsy guarda o conteúdo nas imagens) — elas resolvem por:

- `AUTOPSY_EXPORT_DIR`: pasta de arquivos **exportados** do Autopsy, indexados por SHA-256 (match automático com `tsk_files.sha256`)
- `AUTOPSY_FILES_ROOT`: raiz de um mount **read-only** da imagem, resolvendo `parent_path + name`

Sem nenhum dos dois, as tools respondem com hint explicando a configuração.

## Agente remoto (Windows com Autopsy + agente no Mac/Linux)

O server roda **na máquina do Autopsy** e o agente consome via túnel SSH — nenhuma
porta extra exposta (o server escuta só em `127.0.0.1`).

```bash
# 1. na máquina do Autopsy: sobe o HTTP em localhost
bun run src/index.js --transport http --port 3123     # Windows: start.bat http 3123

# 2. na máquina do agente: túnel
ssh -f -N -L 3123:127.0.0.1:3123 usuario@IP-DO-WINDOWS

# 3. no opencode.json da máquina do agente
#    { "mcp": { "autopsy": { "type": "remote", "url": "http://127.0.0.1:3123/mcp", "enabled": true } } }
```

No Windows, para o server sobreviver a logoff/boot, registre uma tarefa agendada
(rodando como SYSTEM, com o caminho absoluto do bun — o PATH do SYSTEM não tem
`~/.bun/bin`):

```powershell
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c C:\code\coroner\run-http.cmd >> C:\code\coroner\mcp-http.log 2>&1'
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'coroner-http' -Action $action -Trigger $trigger -Principal $principal -Force
Start-ScheduledTask -TaskName 'coroner-http'
```

## Cadeia de custódia

- SQLite aberto com `readonly: true` — o driver rejeita qualquer INSERT/UPDATE/DELETE/DDL
- Testes verificam a **invariância do SHA-256 do `autopsy.db`** após rodar todas as tools
- `extract_file` recusa destinos dentro da pasta do case
- Nenhuma tool aceita SQL arbitrário do LLM — queries são pré-definidas e parametrizadas
- Boa prática: analise uma **cópia** do case; se o Autopsy estiver em ingest, o banco pode estar travado (a tool retorna hint e você tenta de novo)

## Perícia: trilha de auditoria e documentos

Para uso pericial, ligue a **trilha de auditoria** (`AUTOPSY_AUDIT_LOG`, sempre **fora** do case):

```bash
AUTOPSY_AUDIT_LOG=/caminho/fora-do-case/autopsy-audit.ndjson bun run src/index.js
```

- Cada chamada de tool vira um registro NDJSON com `seq`, `ts_utc`, `session`, **case ativo**, consulta/args, resultado (resumo numérico, sem conteúdo de evidência) e duração
- **Trilha por caso**: aponte `AUTOPSY_AUDIT_LOG` para um **diretório** (ex.: `C:\code\audit\trilhas`) e cada case ganha seu arquivo `audit-<case>-<hash>.ndjson` (antes de ativar um case, vai para `audit-_session-<hash>.ndjson`); um caminho de arquivo (com extensão) mantém a trilha única
- Os registros são **encadeados por hash** (`prev`/`hash`): editar, remover ou reordenar uma linha quebra a cadeia e é detectável
- **Fail-closed**: se o log não puder ser gravado, a operação falha (sem log não há validade)
- Verificação por terceiro — pela tool `verify_audit_log` ou pelo CLI:
  ```bash
  bun scripts/audit-verify.mjs /caminho/autopsy-audit.ndjson   # exit 0 = íntegro
  ```

**Selo do encerramento** (hash + arquivamento + assinatura + carimbo RFC 3161):

```bash
bun scripts/audit-seal.mjs /caminho/audit.ndjson /caminho/selo.json \
    --archive /arquivo/audit-<data>.ndjson --key chave.pem --cert cadeia.pem \
    --tsa https://freetsa.org/tsr
bun scripts/audit-seal.mjs --verify /caminho/selo.json                        # exit 0 = íntegro
bun scripts/tsa-verify.mjs --seal /caminho/selo.json --ca freetsa-cacert.pem  # valida o carimbo
```

O algoritmo da assinatura segue a chave: **Ed25519**, **RSA** ou **EC**. Com `--cert`
(`AUTOPSY_SEAL_CERT_FILE`) de um certificado **ICP-Brasil**, o certificado e a cadeia entram no
selo e a chave é conferida contra ele (não repúdio). Pela interface MCP: tool `seal_audit_log`
(requer `AUTOPSY_AUDIT_LOG`; opcionais `AUTOPSY_TSA_URL`, `AUTOPSY_SEAL_KEY_FILE`,
`AUTOPSY_SEAL_CERT_FILE`). O ato de selar é registrado **antes** de selar, então o selo cobre esse
registro; novos registros depois invalidam o selo (refaça ao encerrar). O carimbo é best-effort:
sem TSA acessível o selo sai com `timestamp.ok=false` e o motivo. A verificação não confia no
próprio código: `audit-seal.mjs --verify` roda um **oráculo externo** (`openssl`) para conferir a
assinatura, e `tsa-verify.mjs` confere o imprint e a cadeia do carimbo.

Documentos operacionais em [`docs/pericia/`](docs/pericia/):

| Documento | Uso |
|:--|:--|
| [`laudo-pericial-template.md`](docs/pericia/laudo-pericial-template.md) | Laudo em 10 seções, com o formato de citação de achado |
| [`cadeia-de-custodia.md`](docs/pericia/cadeia-de-custodia.md) | Ficha de custódia, etapas do art. 158-B e tabela de hashes |
| [`checklist-validade.md`](docs/pericia/checklist-validade.md) | Checklist antes/durante/depois + o que fazer quando algo falha |

> A skill `pericia-forense` (config do agente) e o agente `perito-forense` aplicam este
> fluxo automaticamente: validade jurídica primeiro, análise depois.

## Compatibilidade com versões do Autopsy

O server fala com o `autopsy.db`, então funciona com cases de **qualquer Autopsy 4.x**: não depende
de qual versão criou o case, nem do Autopsy estar instalado. Testamos contra o **schema 9**
(incluindo o **9.6** dos cases reais que examinamos), que é o dos 4.x mais antigos, e contra o
schema atual.

Na prática ele **detecta o que existe** em vez de assumir:

| Como | Onde |
|:--|:--|
| Tabelas/colunas opcionais são detectadas antes do uso (`hasTable`, `columns`) | `src/tools.js` |
| Tags: usa `knownStatus` quando existe, senão `content_tags`, senão `blackboard_artifact_tags` | `browse_tags` |
| Timeline: usa `tsk_events` quando existe (eventos com tipo/descrição) e cai para os MAC times de `tsk_files` quando não | `browse_timeline` |
| Contas de SO (tabela `tsk_os_accounts`, Autopsy 4.19+): sem ela, a tool degrada explicando | `get_os_accounts` |
| `get_case_summary` devolve `schema_major`, `schema_minor` e `tsk_version` e **avisa o que o schema não guarda** (ex.: nome/número/data do case, que o 4.x mantém fora do DB) | `get_case_summary` |
| Tabela ausente vira erro com hint explicativo ("no such table → ..."), não stack trace | `src/db.js` |

Regressão: `tests/legacy-schema.test.js` cobre esses caminhos com um schema 9.6 sintético.

> Isto é sobre **ler cases**. O MCP **oficial** do Autopsy é outro produto — veja
> [Conformidade](#conformidade-com-a-spec-do-mcp).

## Conformidade com a spec do MCP

O MCP **oficial** do Autopsy só existe a partir do **4.23.0** (2026-04-15, *"MCP over STDIO Server
(Windows only)"*; o 4.23.1, de 2026-05-07, é o atual) — antes disso não havia MCP no Autopsy, e ele
só enxerga o case aberto no Autopsy rodando.

Nosso server anuncia `additionalProperties: false` em **toda** tool e recusa parâmetro desconhecido com
um erro que nomeia a chave (via `strictSchema()`). Num contexto pericial isso não é cosmético: um
typo no filtro não pode devolver resultado **não filtrado como se fosse filtrado**. Regressão em
`tests/strict-input.test.js`.

Também contribuímos com os defeitos equivalentes encontrados no MCP **oficial** do Autopsy — só
conformidade, sem nenhuma feature nossa:

| Onde | O quê |
|:--|:--|
| PR [sleuthkit/autopsy#8039](https://github.com/sleuthkit/autopsy/pull/8039) | envelope `ListToolsResult` no `tools/list`, passagem direta no wrapper de stdio e `additionalProperties: false` (4 arquivos) |
| [`docs/upstream/coroner-conformance/`](docs/upstream/coroner-conformance/) | patch, `ISSUE.md` com a reprodução e a seção "o que **não** é bug" |
| [`probe-conformance.mjs`](docs/upstream/coroner-conformance/probe-conformance.mjs) | sonda HTTP crua (sem SDK) que lista as violações do bridge |
| [`verify/run.sh`](docs/upstream/coroner-conformance/verify/run.sh) | JUnit real, vermelho→verde, sem precisar do build do Autopsy |
| [`verify/run-wrapper.sh`](docs/upstream/coroner-conformance/verify/run-wrapper.sh) | lado JS: self-test do wrapper + cliente do SDK oficial por stdio, vermelho→verde |
| [Benchmark](docs/benchmark-mcps-autopsy.md) | nosso MCP × os de Autopsy/DFIR existentes, com fontes e o roadmap |

Lição que ficou do episódio: o `tools/list` do Java devolvia um array e o wrapper de stdio **criava**
o envelope — consertar só o Java duplicaria o envelope (`{"tools":{"tools":[…]}}`) e quebraria o
Claude Desktop. Formato que atravessa mais de um componente tem consumidor real em cada ponta.

## Desenvolvimento

```bash
bun test                # 120 testes: tools, readonly, custódia, protocolo MCP, auditoria/selo, entrada estrita
bun run test:coverage   # idem, com cobertura
bun run lint            # biome
bun run typecheck       # JSDoc via tsc
```

Arquitetura: `src/db.js` (readonly + hints) → `src/tools.js` (funções puras) → `src/server.js` (camada MCP). Veja `AGENTS.md`.

## Licença

GPL-3.0-or-later — veja [`LICENSE`](LICENSE). Copyright (C) 2026 Gutem.
