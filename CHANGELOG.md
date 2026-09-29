# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- **Parâmetro desconhecido em uma tool agora é erro explícito** (antes o zod o descartava em
  silêncio e a tool rodava **sem** o filtro, devolvendo resultado não filtrado como se fosse
  filtrado — mesma classe da issue sleuthkit/autopsy#8033): todo `inputSchema` passa a anunciar
  `additionalProperties: false` e a chamada falha nomeando a chave inválida, para o agente se
  autocorrigir. Cobre as 21 tools via `strictSchema()`; regressão em `tests/strict-input.test.js`.

### Added
- **Pacote de conformidade para o MCP oficial do Autopsy**
  (`docs/upstream/coroner-conformance/`): patch de 4 arquivos (envelope `ListToolsResult` no
  Java, passagem direta no wrapper de stdio, `additionalProperties: false` e teste JUnit),
  `ISSUE.md` com a reprodução e a seção "o que não é bug", a sonda HTTP `probe-conformance.mjs` e
  **duas verificações vermelho→verde** — `verify/run.sh` (JUnit real, sem o build do Autopsy) e
  `verify/run-wrapper.sh` (self-test do wrapper + cliente do SDK oficial por stdio). Enviado como
  PR [sleuthkit/autopsy#8039](https://github.com/sleuthkit/autopsy/pull/8039).
- **`docs/benchmark-mcps-autopsy.md`**: levantamento com fontes do nosso MCP contra os de
  Autopsy/DFIR existentes — cobertura, lacunas e o roadmap derivado.
- **Trilha rotativa por caso**: `AUTOPSY_AUDIT_LOG` apontando para um diretório gera
  `audit-<case>-<hash8>.ndjson` por case (e `audit-_session-<hash8>.ndjson` antes de ativar),
  com continuidade de cadeia entre sessões do mesmo case; caminho de arquivo mantém trilha única
- **Selo do encerramento** (`seal_audit_log` / `scripts/audit-seal.mjs`): SHA-256 do log +
  verificação da cadeia + arquivamento imutável (recusa sobrescrever) + assinatura **Ed25519, RSA
  ou EC** (payload canônico; com `--cert`/`AUTOPSY_SEAL_CERT_FILE` o certificado e a cadeia
  ICP-Brasil entram no selo e a chave é conferida contra ele) + carimbo de tempo **RFC 3161**
  best-effort (token `.tsr` gravado e validável por `openssl ts`). `verifySeal` detecta log
  alterado depois do selo; a verificação roda um oráculo externo (`openssl`) em vez de confiar no
  próprio código, e `scripts/tsa-verify.mjs` confere o imprint e a cadeia do carimbo.
- **Trilha de auditoria** (`AUTOPSY_AUDIT_LOG`): NDJSON append-only com encadeamento de hash
  (tamper-evident), case ativo por registro, fail-closed e tool `verify_audit_log` +
  `scripts/audit-verify.mjs` para verificação independente por terceiro
- `docs/pericia/`: template de laudo, ficha de cadeia de custódia (art. 158-B) e checklist
  de validade (antes/durante/depois)
- Skill `pericia-forense` + agente `perito-forense` (config do opencode): validade jurídica
  antes de qualquer leitura de evidência
- Camada de análise investigativa: `find_files` (MIME/extensão/hash/known/tamanho/janela),
  `find_artifacts` (busca em todos os atributos), `extract_conversations` (chat por
  participante), `open_sqlite` (SELECT read-only em app db da imagem: WhatsApp,
  Chromium, iOS) e `export_evidence` (extrato JSON citável para o laudo)
- Compatibilidade com o schema do Autopsy 4.x (schema 9): `content_tags`/
  `blackboard_artifact_tags`, `tsk_os_accounts`, `tsk_events`, `knownStatus`
- `browse_filesystem` lista os filesystems de `tsk_fs_info` nas raízes (atalho para
  pular volume system/volume) e atravessa nós sem `tsk_files`
- `browse_timeline` com `order=asc|desc` (evita OFFSET profundo em cases grandes)
- `deploy/` com provisionamento reproduzível (Windows + túnel autossh no macOS)
- MCP server read-only para cases do Autopsy (Bun + `bun:sqlite`, driver `readonly`)
- 21 tools: list/set case, summary, filesystem, blackboard artifacts, keywords,
  metadata, tags, timeline, OS accounts, keyword hits, hex/strings/extract, a camada de
  análise (`find_*`, `open_sqlite`, `export_evidence`) e as de perícia (`verify_audit_log`,
  `seal_audit_log`)
- Transportes stdio e HTTP (StreamableHTTP com sessões por agente)
- Conteúdo de arquivos via `AUTOPSY_EXPORT_DIR` (índice lazy sha256→path) e `AUTOPSY_FILES_ROOT`
- Erros auto-explicativos para auto-correção do LLM (hints de schema, tabelas, lock)
- Testes: fixture sintética do schema TSK, invariância do SHA-256 do `autopsy.db`,
  protocolo MCP completo (InMemoryTransport e StreamableHTTP), entrada estrita, cadeia de
  custódia, trilha e selo — 120 testes no total
