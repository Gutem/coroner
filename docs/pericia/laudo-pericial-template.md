# Laudo pericial — template

> Preencher **todos** os campos. Onde não houver dado, escrever explicitamente
> `não aplicável` ou `não foi possível apurar` — nunca deixar em branco.

---

## 1. Identificação

| Campo | Valor |
|:--|:--|
| Processo / procedimento | |
| Autoridade requisitante | |
| Perito (nome, titulação, documento) | |
| Natureza do exame | (perícia oficial / nomeado / assistente técnico → **parecer**) |
| Local e data do exame | |
| Início / término (UTC-3 e UTC) | |

## 2. Objeto (material examinado)

| Campo | Valor |
|:--|:--|
| Descrição do item | |
| Origem / quem entregou | |
| Data e forma de recebimento | |
| Lacre (nº / estado) | |
| **SHA-256 do original** | |
| **SHA-256 da cópia de trabalho** | |
| Algoritmo / ferramenta do hash | |

## 3. Cadeia de custódia

| Data/hora (UTC-3) | Etapa (CPP art. 158-B) | Responsável | Documento | Observação |
|:--|:--|:--|:--|:--|
| | recebimento | | termo de recebimento | conferência de hash: confere |
| | armazenamento | | | |
| | processamento | | | cópia de trabalho, montagem read-only |

**Lacunas**: declarar aqui qualquer intervalo sem rastreabilidade.

## 4. Metodologia e ferramentas

| Ferramenta | Versão | Identificação (hash/commit) |
|:--|:--|:--|
| Autopsy | | |
| TSK | | |
| coroner (servidor MCP) | | commit `______` |
| Runtime (Bun) | | |
| Sistema operacional do examinador | | |

- Mecanismo de **write-block**: (hardware / montagem read-only / abertura de DB em `readonly`)
- **Trilha de auditoria**: `AUTOPSY_AUDIT_LOG=______` · verificação: `verify_audit_log` / `bun scripts/audit-verify.mjs <arquivo>`
  - resultado: `ok=true`, `count=___`, `last_hash=______`
- **Integridade do case**: teste de invariância do SHA-256 do `autopsy.db` — (executado / não executado)

## 5. Exames realizados

Para cada exame, registrar a consulta **literal** (reproduzível) — o detalhamento completo vai no apêndice A.

| # | Objetivo | Consulta/filtro (literal) | Instante (UTC) | Ferramenta |
|:--|:--|:--|:--|:--|
| 1 | | | | |

## 6. Achados

Cada achado com a **citação padrão**: `obj_id` · caminho · hash · consulta · UTC · ferramenta.
Separar **FATO** (nível 1–2) de **ANÁLISE** (nível 5).

### Achado 1 — <título>

- **FATO**: …
- **Fonte**: `obj_id=______` · `C:\...\caminho` · SHA-256 `______` (ou "não disponível no case")
- **Consulta**: `` SELECT … `` (apêndice A, item __)
- **Integridade do conteúdo**: confirmada por hash `sim`/`não` (se não, declarar "não confirmada")
- **ANÁLISE** (se houver): …

## 7. Limitações e ressalvas

- Artefatos ausentes por falta de ingest (ex.: blackboard vazio) …
- Integridade de conteúdo não confirmada por hash em … (impacto: …)
- Acesso parcial a … (motivo: …)
- Não foi objeto deste exame: …

## 8. Conclusão (por quesito)

| Quesito | Resposta | Achado(s) que sustenta(m) |
|:--|:--|:--|
| 1 | | |

## 9. Anexos

| Anexo | Arquivo | SHA-256 |
|:--|:--|:--|
| A — apêndice de consultas | | |
| B — extrato de evidências (JSON) | | |
| C — trilha de auditoria (NDJSON) | | |

## 10. Encerramento

Local, data. Assinatura do perito (nome, titulação, documento).

---

**Aditamento** (se necessário após assinatura): data, motivo, o que mudou — nunca reescrever silenciosamente.
