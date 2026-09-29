# Checklist de validade — antes / durante / depois

Imprimir (ou copiar para `reports/<caso>/`) e preencher. Item não cumprido = declarar no laudo.

## Antes do exame

- [ ] Perito habilitado identificado; escopo e **quesitos** formalizados
- [ ] Hash da evidência **informado na origem** e **conferido** no recebimento
- [ ] Cópia de trabalho criada; **hash da cópia** registrado
- [ ] Original preservado e lacrado (nunca montado em modo escrita)
- [ ] Ferramentas e **versões** anotadas (Autopsy, TSK, runtime, **commit do `coroner`**)
- [ ] `AUTOPSY_AUDIT_LOG` configurado **fora do case** (trilha com cadeia de hash)
- [ ] Destino de saída (laudo, extratos) definido **fora** do case/evidência
- [ ] Autorização/requisição arquivada (quem pediu, para quê)

## Durante o exame

- [ ] Nenhuma escrita na evidência/case (montagem ro, DB `readonly`, export fora)
- [ ] Cada consulta guardada **literalmente** (SQL/filtros/params) + instante UTC
- [ ] Case ativo registrado por bloco (sem mistura de casos)
- [ ] Conteúdo usado em conclusão **confirmado por hash** — ou rotulado "não confirmado"
- [ ] Vestígios de PII limitados ao necessário (LGPD); dado sensível isolado
- [ ] Achados anotados com a citação padrão (`obj_id` · caminho · hash · consulta · UTC · ferramenta)
- [ ] Fato separado de análise (níveis 1–5)

## Depois do exame

- [ ] SHA-256 de **cada derivado** (JSON, CSV, PDF, laudo) calculado e registrado
- [ ] `autopsy.db` antes × depois: **inalterado** (invariância)
- [ ] `verify_audit_log` (ou `scripts/audit-verify.mjs`) → `ok=true`; anexar a saída
- [ ] Anexos com a tabela de hashes e o mapa `obj_id → caminho → hash`
- [ ] Limitações e lacunas declaradas explicitamente
- [ ] Conclusão responde **a cada quesito**, sem extrapolar
- [ ] Laudo assinado; após assinatura, correção só por **aditamento** (com data e motivo)
- [ ] Cópia de trabalho, logs e hashes arquivados; descarte conforme art. 158-B registrado

---

### Se algo falhar

| Falha | Ação |
|:--|:--|
| Hash do recebimento ≠ origem | **não examinar**; comunicar a autoridade e registrar |
| `autopsy.db` mudou durante o exame | investigar quem/quando; o exame pode estar comprometido |
| Cadeia de auditoria quebrada (`broken_at`) | identificar o ponto; refazer o exame do marco em diante em material íntegro |
| Ferramenta sem versão registrável | não usar para conclusão; substituir por equivalente versionada |
| Conteúdo sem hash no case | declarar "integridade não confirmada" — não afirmar identidade do arquivo |
