# Cadeia de custódia — ficha e tabela de hashes

Base: **CPP art. 158-A a 158-F** (Lei 13.964/2019). A cadeia é do **vestígio**, não do
processo: qualquer intervalo sem responsável identificado é uma lacuna a declarar.

> Conferir a **redação vigente** dos artigos antes de citar incisos no laudo.

## Ficha de custódia (por item)

| Campo | Valor |
|:--|:--|
| Nº do item / lacre | |
| Descrição (mídia, modelo, nº de série) | |
| Origem (quem produziu/apreendeu, data, local) | |
| **Hash informado na origem** (algoritmo + valor) | |
| **Hash conferido no recebimento** | ( ) confere ( ) não confere → se não confere, **não iniciar exame** |
| Data/hora do recebimento (UTC-3) | |
| Recebido por (nome, documento, função) | |
| Condições do lacre | |
| Armazenamento (local, acesso restrito a) | |
| Cópia de trabalho criada em | |
| **Hash da cópia de trabalho** | |
| Previsão de descarte (art. 158-B) | |

## Etapas (art. 158-B) — marcar com responsável e data

| Etapa | Responsável | Data/hora | Documento |
|:--|:--|:--|:--|
| Reconhecimento | | | |
| Coleta | | | |
| Acondicionamento | | | |
| Transporte | | | |
| Recebimento | | | |
| Processamento (exame) | | | |
| Armazenamento | | | |
| Descarte | | | |

## Tabela de hashes (a cadeia inteira)

| Objeto | Algoritmo | Hash | Quando (UTC) | Ferramenta |
|:--|:--|:--|:--|:--|
| Evidência original | SHA-256 | | | |
| Conferência no recebimento | SHA-256 | | | |
| Cópia de trabalho | SHA-256 | | | |
| `autopsy.db` (antes do exame) | SHA-256 | | | |
| `autopsy.db` (depois do exame) | SHA-256 | | | **deve ser igual** |
| Extrato de evidências (JSON) | SHA-256 | | | |
| Trilha de auditoria (NDJSON) | SHA-256 | | | |
| Laudo final (PDF/MD) | SHA-256 | | | |

## Comandos

```powershell
# Windows — hash de arquivo
Get-FileHash -Algorithm SHA256 .\evidencia.img | Format-List
certutil -hashfile .\evidencia.img SHA256
```

```bash
# macOS/Linux
shasum -a 256 evidencia.img
```

```bash
# Trilha de auditoria do servidor MCP (verificação independente)
bun scripts/audit-verify.mjs /caminho/audit.ndjson     # exit 0 = íntegro
```

## Trilha por caso (recomendado)

Aponte `AUTOPSY_AUDIT_LOG` para um **diretório** (sem extensão) e cada case ganha sua própria
trilha — o anexo do laudo é só o arquivo daquele exame, sem mistura:

```
C:\code\audit\trilhas\
├── audit-_session-<hash8>.ndjson        atividade sem case ativo (list_cases etc.)
├── audit-ACME-<hash8>.ndjson            exame do case ACME
└── audit-Contoso-<hash8>.ndjson         exame do case Contoso
```

- O rótulo vem do nome do case (sanitizado) e o `<hash8>` é do diretório do case — dois cases
  homônimos **não colidem**.
- Retomar o mesmo case em outra sessão **continua** a mesma trilha (a cadeia segue de onde parou).
- Com caminho de **arquivo** (com extensão) o comportamento antigo se mantém: trilha única.

## Assinatura com ICP-Brasil (não repúdio)

Sem certificado, a assinatura do selo é Ed25519 — prova integridade técnica, mas não
identifica o responsável. Para **não repúdio**, use o seu e-CPF/e-CNPJ A1:

```bash
# 1) extraia a chave e a cadeia do seu .p12 (a senha NÃO vai para o servidor)
openssl pkcs12 -in cert.p12 -nocerts -nodes -out seal-key.pem
openssl pkcs12 -in cert.p12 -clcerts -nokeys -out cert.pem
openssl pkcs12 -in cert.p12 -cacerts -nokeys -out chain.pem
cat cert.pem chain.pem > signer-chain.pem

# 2) aponte o servidor para elas (RSA-SHA256 ou EC P-256/P-384; PKCS#12 direto não é aceito)
#    AUTOPSY_SEAL_KEY_FILE=C:\code\audit\seal-key.pem
#    AUTOPSY_SEAL_CERT_FILE=C:\code\audit\signer-chain.pem
```

O selo passa a registrar `signature.algorithm: rsa-sha256`, o titular (`certificate.subject`),
o serial, a validade e o hash do certificado. Se a chave não corresponder ao certificado, o
sele **recusa** (SPKI diferente) — nunca sai um selo ambíguo.

Para o carimbo de tempo, aponte `AUTOPSY_TSA_URL` para a ACT da sua cadeia ICP-Brasil (é o
mesmo protocolo RFC 3161; a resposta traz a cadeia da TSA no próprio token). Guarde junto o
certificado da raiz para a verificação por terceiro.

## Verificação por terceiro (o que anexar ao laudo)

Três checagens independentes, todas fora do servidor:

```bash
# 1) cadeia de hashes da trilha (não depende de chave nenhuma)
bun scripts/audit-verify.mjs trilhas/audit-ACME-545d2fc3.ndjson

# 2) selo: sha256 do log + assinatura + (com --key/--cert) a origem — inclui oráculo openssl
bun scripts/audit-seal.mjs --verify trilhas/selo-ACME.json

# 3) carimbo de tempo: imprint == sha256 do log  E  cadeia da TSA (com --ca)
curl -fsS https://freetsa.org/files/cacert.pem -o freetsa-cacert.pem
bun scripts/tsa-verify.mjs --seal trilhas/selo-ACME.json --ca freetsa-cacert.pem
```

Resultado esperado (carimbo): `"granted": true`, `"imprint_matches_data": true`,
`"trusted_ca": true`, `Verification: OK`. Sem `--ca` o carimbo confere o imprint mas
`trusted_ca` sai `null` — **não** é validação completa da identidade da TSA.

Se log+selo+token forem arquivados **juntos** (mesmo basename, ao lado do selo), a verificação
continua funcionando sem o original: quando o caminho declarado não existe, a verificação procura
o arquivo de mesmo nome ao lado do selo — vale para o log, para o token do carimbo e para a cópia
registrada em `archive`. O caminho Windows é entendido se a verificação for feita no macOS/Linux.
Consequência prática: o pacote do laudo pode ser movido para o cofre sem quebrar a prova.

## Selo da trilha (no encerramento do exame)

O selo é o artefato que **fecha** a trilha de auditoria e vai para o anexo do laudo.

```bash
# via CLI (recomendado no encerramento) — fora do case
bun scripts/audit-seal.mjs /caminho/audit.ndjson /caminho/selo.json \
    --archive /arquivo/audit-<data>.ndjson \
    --key /caminho/chave-ed25519.pem \
    --tsa https://freetsa.org/tsr

# verificar um selo depois (por qualquer terceiro)
bun scripts/audit-seal.mjs --verify /caminho/selo.json     # exit 0 = íntegro
```

Ou pela interface MCP: tool `seal_audit_log` (`AUTOPSY_AUDIT_LOG` ligado). O servidor registra
o **próprio ato de selar antes de selar**, então o selo cobre esse registro — e qualquer
registro novo depois **invalida** o selo (refaça o selo ao final).

O selo JSON contém:

| Campo | O que prova |
|:--|:--|
| `log.sha256` | o log não mudou desde o selo (basta recalcular o SHA-256 do arquivo) |
| `chain` | a cadeia de hash estava íntegra no momento do selo (`count`, `last_hash`) |
| `archive.path/sha256` | cópia imutável da trilha (o selo recusa sobrescrever arquivo existente) |
| `signature` (Ed25519) | quem detinha a chave assinou aquele conteúdo — `signablePayload` é o canon |
| `timestamp` (RFC 3161) | **quando** aquele hash existia, atestado por uma TSA — resiste a "foi criado depois" |

### Verificar o carimbo de tempo (RFC 3161)

```bash
openssl ts -reply -in /caminho/selo.json.tsr -text
# confira o "Message imprint" == log.sha256 do selo, e o "Time stamp" (UTC)
```

> O carimbo é **best-effort**: se a TSA estiver inacessível (proxy corporativo, rede), o selo
> ainda sai — com `timestamp.ok=false` e o motivo. A ausência do carimbo **deve ser declarada**
> no laudo; a trilha não se perde por causa disso.

### Passo a passo do encerramento

1. Confirmar que não haverá mais consultas ao case.
2. `seal_audit_log` (ou o CLI) com `archivePath` + `--key` + `--tsa`.
3. Rodar `--verify` no selo e **anexar a saída** (com o `sha256` do log e do selo).
4. Calcular o SHA-256 do próprio selo e do `.tsr` e registrá-los na tabela de hashes.
5. Anexar ao laudo: trilha (NDJSON), selo (JSON) e token (`.tsr`).

## Regras rápidas

1. Hash da origem **conferido** antes de qualquer exame — divergiu, para e comunica.
2. Exame **só** sobre cópia de trabalho; original lacrado.
3. **Nunca** montar/abrir a evidência em modo escrita.
4. Cada derivado (export, extrato, laudo) tem hash **próprio**.
5. `autopsy.db` **antes = depois** (invariância) — o servidor tem teste automatizado disso.
6. Toda lacuna (tempo sem responsável, lacre violado, acesso não registrado) é **declarada** no laudo.
