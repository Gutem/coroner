#!/usr/bin/env bash
#
# Verifica o patch de conformidade do MCP do Autopsy SEM precisar do build do Autopsy.
#
# Monta DUAS árvores, cada uma com o McpProtocolHandler REAL + um TskQueryService stub cujas
# definições de tool são copiadas verbatim da fonte daquela árvore:
#   (1) upstream  -> os helpers vêm do arquivo original; o teste precisa FALHAR (as duas asserções são os bugs)
#   (2) pós-patch -> os helpers vêm do arquivo JÁ PATCHEADO; o teste precisa PASSAR
# Se qualquer rodada sair do esperado, o script termina com erro — a verificação é do patch,
# não uma demonstração.
#
# Nota de desenho: as rodadas montam os stubs a partir da fonte de cada etapa em vez de aplicar o
# patch em cima do stub. O patch Javadoc/reescrita as definições de tool, e exigir que ele
# aplicasse no stub sintético acoplava a verificação à vizinhança exata dos helpers (quebrava a
# cada comentário novo). Assim a rodada 2 testa exatamente o código que o patch propõe.
#
# Requisitos: JDK 11+, git, curl, python3.
# Uso: ./run.sh            (usa um diretório temporário)
#      WORK=/tmp/x ./run.sh (diretório de trabalho fixo, para inspecionar)
#
set -euo pipefail

REF="${REF:-cb3dacdcad67abe7cf863c74f10dcdb8e25a5c21}"   # commit do Autopsy usado na verificação
WORK="${WORK:-$(mktemp -d)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCH="$HERE/../coroner-conformance.patch"
RAW="https://raw.githubusercontent.com/sleuthkit/autopsy/$REF/Core/src/org/sleuthkit/autopsy/mcp"
MAVEN="https://repo1.maven.org/maven2"
RAIZ="$WORK/upstream"
MCP="org/sleuthkit/autopsy/mcp"
JARS=(
  "junit/junit/4.13.2/junit-4.13.2.jar"
  "org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar"
  "com/fasterxml/jackson/core/jackson-databind/2.17.2/jackson-databind-2.17.2.jar"
  "com/fasterxml/jackson/core/jackson-core/2.17.2/jackson-core-2.17.2.jar"
  "com/fasterxml/jackson/core/jackson-annotations/2.17.2/jackson-annotations-2.17.2.jar"
)

echo "== harness em $WORK (Autopsy @ ${REF:0:12}) =="
mkdir -p "$RAIZ" "$WORK/lib"

echo "== 1/5 baixando o código do upstream =="
for f in McpProtocolHandler.java McpException.java TskQueryService.java; do
  curl -sSL --fail --max-time 60 "$RAW/$f" -o "$RAIZ/$f" || { echo "FALHOU baixar $f"; exit 2; }
done
echo "   ok: $(ls "$RAIZ" | tr '\n' ' ')"

echo "== 2/5 dependências =="
for j in "${JARS[@]}"; do
  [ -f "$WORK/lib/$(basename "$j")" ] || curl -sSL --fail --max-time 120 -o "$WORK/lib/$(basename "$j")" "$MAVEN/$j"
done
echo "   ok: $(ls "$WORK/lib" | wc -l | tr -d ' ') jars"

# Monta a árvore de uma rodada: fontes reais + stub de TskQueryService + teste do patch.
# $1 = diretório da árvore   $2 = TskQueryService de onde extrair os helpers (stub verbatim)
montar() {
  local arvore="$1" fonte="$2"
  mkdir -p "$arvore/Core/src/$MCP" "$arvore/Core/test/unit/src/$MCP"
  # nao use "cp -n": no BSD (macOS) ele SAI COM ERRO quando pula o arquivo existente,
  # e com "set -e" isso mata o script. Teste a existencia explicitamente.
  for f in McpProtocolHandler.java McpException.java; do
    [ -f "$arvore/Core/src/$MCP/$f" ] || cp "$RAIZ/$f" "$arvore/Core/src/$MCP/"
  done
  python3 "$HERE/prepare.py" "$fonte" "$PATCH" \
    "$arvore/Core/src/$MCP/TskQueryService.java" "$arvore/Core/test/unit/src/$MCP/McpProtocolHandlerTest.java"
}

rodar() {  # $1 = árvore   $2 = rótulo   -> imprime a saída do JUnit
  local arvore="$1" out="$1/out"
  javac -nowarn -cp "$WORK/lib/*" -d "$out" $(find "$arvore/Core" -name '*.java') 2>&1 | head -20
  java -cp "$out:$WORK/lib/*" org.junit.runner.JUnitCore \
    org.sleuthkit.autopsy.mcp.McpProtocolHandlerTest 2>&1 || true
}

echo "== 3/5 rodada 1: árvore UPSTREAM (deve falhar) =="
montar "$WORK/antes" "$RAIZ/TskQueryService.java"
SAIDA_ANTES="$(rodar "$WORK/antes")"
echo "$SAIDA_ANTES" | grep -E '^Tests run|^OK|AssertionError' | head -4
if ! echo "$SAIDA_ANTES" | grep -q 'Failures: 2'; then
  echo "  ESPERADO 2 falhas no código upstream — o teste não está exercitando os bugs"; exit 1
fi

echo "== 4/5 rodada 2: árvore PÓS-PATCH (deve passar) =="
mkdir -p "$WORK/depois/Core/src/$MCP"
cp "$RAIZ/McpProtocolHandler.java" "$RAIZ/McpException.java" "$RAIZ/TskQueryService.java" "$WORK/depois/Core/src/$MCP/"
git -C "$WORK/depois" init -q
# so o lado Java: o patch tambem mexe no wrapper de stdio (Tools/...), que nao existe nesta arvore
git -C "$WORK/depois" apply -p1 --include='Core/*' "$PATCH"
# stub a partir do arquivo JÁ PATCHEADO (helpers com additionalProperties + Javadoc)
montar "$WORK/depois" "$WORK/depois/Core/src/$MCP/TskQueryService.java"

echo "== 5/5 rodada 2 (JUnit) =="
SAIDA_DEPOIS="$(rodar "$WORK/depois")"
echo "$SAIDA_DEPOIS" | grep -E '^Tests run|^OK|AssertionError' | head -4
if ! echo "$SAIDA_DEPOIS" | grep -q 'OK (2 tests)'; then
  echo "  ESPERADO OK (2 tests) com o patch aplicado"; exit 1
fi

echo
echo "VERIFICAÇÃO OK — antes: 2 falhas (ListToolsResult array + additionalProperties); depois: OK (2 tests)."
