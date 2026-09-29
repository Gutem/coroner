# Verificação executada do patch (as duas pontas: Java e o wrapper de stdio)

O patch mexe em duas pontas que precisam mudar juntas: o handler Java (que passa a devolver o
`ListToolsResult`) e o wrapper de stdio em JS (que precisa parar de envelopar de novo). Cada ponta
tem o seu harness, e cada um é **vermelho→verde**: o script termina com erro se qualquer rodada sair
do esperado, então ele verifica o patch em vez de ilustrá-lo.

Commit do Autopsy usado nos dois: **`cb3dacdcad67abe7cf863c74f10dcdb8e25a5c21`** (2026-05-04), pinado
para reprodutibilidade. Sobrescreva com `REF=<sha>` para rodar contra outro ponto.

## Lado Java — `./run.sh`

O `TskQueryService` depende da árvore inteira do Autopsy (TSK/NetBeans) e não compila fora do build
deles. Mesmo assim o teste JUnit do patch **foi executado**, com uma montagem honesta:

| Peça | O que é | Fidelidade |
|:--|:--|:--|
| `McpProtocolHandler.java` | **o arquivo real do upstream** | integral |
| `McpException.java` | o arquivo real do upstream | integral |
| `TskQueryService.java` | **stub** cujo `listTools()` e os helpers (`tool`, `toolWithNote`, `param`) são copiados **verbatim da fonte da rodada** — do upstream na rodada 1, do arquivo já patchado na rodada 2; os demais métodos só satisfazem a compilação | as definições de tool que o teste avalia são as reais |
| `McpProtocolHandlerTest.java` | extraído **de dentro do próprio patch** | integral |
| Jackson / JUnit 4.13.2 | Maven Central | versões correntes |

**Por que duas árvores:** cada rodada monta seu próprio stub a partir da fonte daquela etapa em vez
de aplicar o patch em cima do stub sintético. O patch mexe justamente nas definições de tool, então
exigir que ele aplicasse no stub acoplava a verificação à vizinhança exata dos helpers — qualquer
comentário novo quebrava o `git apply` sem que houvesse nada errado com o fix.

```bash
./run.sh              # usa um diretório temporário
WORK=/tmp/verify ./run.sh   # diretório fixo, para inspecionar os arquivos
```

Requisitos: JDK 11+, git, curl, python3.

Resultado observado:

```
== 3/5 rodada 1: árvore UPSTREAM (deve falhar) ==
java.lang.AssertionError: ListToolsResult must be a JSON object, was: ARRAY
Tests run: 2,  Failures: 2

== 5/5 rodada 2 (JUnit) ==
OK (2 tests)
```

## Lado JS — `./run-wrapper.sh`

É a ponta onde um meio-fix regride: se o Java passar a devolver o objeto e o wrapper continuar
esperando array, o wrapper envelopa de novo (`{"tools":{"tools":[…]}}`) e o Claude Desktop quebra.
O harness baixa o wrapper pinado, instala o SDK oficial, sobe um **stub do MCP HTTP**
(`stub-java-mcp.mjs`, sem dependências) que já responde no formato pós-fix, e checa duas coisas nas
duas direções:

| Checagem | Como | O que é |
|:--|:--|:--|
| `--test` do próprio wrapper | `node autopsy-mcp-stdio.js --test` com um `LOCALAPPDATA` falso (token + porta do stub) | é o código que o patch muda |
| cliente do SDK oficial | `wrapper-client.mjs` fala MCP por stdio com o wrapper e chama `tools/list` | é o que o Claude Desktop faz; valida contra `ListToolsResult` |

```bash
./run-wrapper.sh              # diretório temporário
WORK=/tmp/verifyjs ./run-wrapper.sh
```

Requisitos: node 18+, npm (para o SDK), python3 (porta livre).

Resultado observado:

```
== 4/5 rodada 1: wrapper UPSTREAM (deve falhar) ==
  [FAIL] tools/list returned 0 tools (expected ≥ 15)
Result: FAIL
listTools FAIL: [ { "expected": "array", "code": "invalid_type", "path": [ "tools" ],
                    "message": "Invalid input: expected array, received object" } ]

== 5/5 rodada 2: patch aplicado no wrapper (deve passar) ==
  [OK] 18 tools available
Result: PASS
listTools OK: 18 tools
```

A mensagem do cliente é o bug inteiro em uma linha: `path: ["tools"], expected: "array", received
object` — o wrapper entregando um objeto onde o `ListToolsResult` exige o array.

## O que estas verificações NÃO cobrem

- **Compilação dentro do build do Autopsy** (NetBeans/Ant) e a suíte `Core` completa — aqui não há o
  `TskQueryService` real nem as dependências do TSK. O patch aplica limpo no commit pinado
  (`git apply --check`), mas o `ant` deles é a palavra final.
- **Comportamento com um case aberto**: os testes focam em `tools/list`, que é o que quebra clientes
  e não depende de case.
- **O bridge real na porta 8743**: o lado JS roda contra um stub que emula o pós-fix. O probe
  HTTP contra o bridge de verdade está em `../probe-conformance.mjs` e foi rodado contra o 4.23.1.
