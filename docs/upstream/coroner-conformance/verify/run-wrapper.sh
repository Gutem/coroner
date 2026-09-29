#!/usr/bin/env bash
#
# Verifica o lado JS do patch: o wrapper de stdio (Tools/autopsy-mcp-stdio) contra um stub do
# MCP HTTP do Autopsy que já responde no formato PÓS-PATCH (ListToolsResult).
#
# Duas checagens, cada uma vermelha->verde:
#   (a) o self-test do próprio wrapper (`--test`) — é o código que o patch muda
#   (b) um cliente MCP do SDK oficial chamando `tools/list` pelo stdio — é o que o Claude
#       Desktop faz, e valida a resposta contra ListToolsResult
#
# Sem o trecho JS do patch, o Java devolvendo o objeto faz o wrapper envelopar de novo
# (`{"tools":{"tools":[…]}}`) e o self-test reprovar. Com o patch, as duas passam.
#
# Requisitos: node 18+, npm (rede, para o SDK), python3.
# Uso: ./run-wrapper.sh   |   WORK=/tmp/x ./run-wrapper.sh
#
set -euo pipefail

REF="${REF:-cb3dacdcad67abe7cf863c74f10dcdb8e25a5c21}"
WORK="${WORK:-$(mktemp -d)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCH="$HERE/../coroner-conformance.patch"
RAW="https://raw.githubusercontent.com/sleuthkit/autopsy/$REF/Tools/autopsy-mcp-stdio"
WRAP="$WORK/Tools/autopsy-mcp-stdio"
LAPP="$WORK/lappdata"
PORTA="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"

com_timeout() { perl -e 'alarm shift; exec @ARGV' "$@"; }

echo "== harness JS em $WORK (stub na porta $PORTA) =="

echo "== 1/5 baixando o wrapper do upstream =="
mkdir -p "$WRAP"
curl -sSL --fail --max-time 60 "$RAW/autopsy-mcp-stdio.js" -o "$WRAP/autopsy-mcp-stdio.js"
curl -sSL --fail --max-time 60 "$RAW/package.json" -o "$WRAP/package.json"
[ "$(wc -l < "$WRAP/autopsy-mcp-stdio.js")" -gt 100 ] || { echo "wrapper baixado suspeito"; exit 2; }
echo "   ok: $(wc -l < "$WRAP/autopsy-mcp-stdio.js") linhas"

echo "== 2/5 dependencias do wrapper (SDK MCP via npm) =="
if ! (cd "$WRAP" && npm install --omit=dev --no-audit --no-fund --loglevel=error >"$WORK/npm.log" 2>&1); then
  echo "   FALHOU npm install:"; tail -5 "$WORK/npm.log"; exit 2
fi
(cd "$WRAP" && node -e 'import("@modelcontextprotocol/sdk/client/index.js").then(()=>console.log("   ok: SDK resolve")).catch(e=>{console.error("   FALHOU o SDK: "+e.message);process.exit(1)})')
# o cliente precisa morar ao lado do node_modules do wrapper para resolver o SDK
cp "$HERE/wrapper-client.mjs" "$WRAP/_verify-client.mjs"

echo "== 3/5 stub do MCP do Java + LOCALAPPDATA falso =="
mkdir -p "$LAPP/autopsy/mcp"
printf 'token-de-teste\n' > "$LAPP/autopsy/mcp/mcp-token"
printf 'port=%s\n' "$PORTA" > "$LAPP/autopsy/mcp/mcp-config.properties"
node "$HERE/stub-java-mcp.mjs" "$PORTA" & STUB=$!
trap 'kill "$STUB" 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORTA/mcp" && break; sleep 0.25; done
echo "   ok: stub respondendo"

self_test() { LOCALAPPDATA="$LAPP" com_timeout 90 node "$WRAP/autopsy-mcp-stdio.js" --test 2>&1 || true; }
cliente()   { com_timeout 90 node "$WRAP/_verify-client.mjs" "$WRAP/autopsy-mcp-stdio.js" "$LAPP" 2>&1 || true; }

echo "== 4/5 rodada 1: wrapper UPSTREAM (deve falhar) =="
SAIDA_ST="$(self_test)"
echo "$SAIDA_ST" | grep -E 'FAIL|Result:' | head -3
echo "$SAIDA_ST" | grep -q 'Result: FAIL' || { echo "  ESPERADO FAIL no self-test do wrapper upstream"; exit 1; }
SAIDA_CL="$(cliente)"
echo "$SAIDA_CL" | grep -E '^listTools (FAIL|OK)' | head -1
echo "$SAIDA_CL" | grep -q '^listTools FAIL' || { echo "  ESPERADO FAIL no cliente SDK com o wrapper upstream"; exit 1; }

echo "== 5/5 rodada 2: patch aplicado no wrapper (deve passar) =="
git -C "$WORK" init -q
git -C "$WORK" apply --include='Tools/autopsy-mcp-stdio/*' "$PATCH"
SAIDA_ST2="$(self_test)"
echo "$SAIDA_ST2" | grep -E 'OK\] [0-9]+ tools|Result:' | head -3
echo "$SAIDA_ST2" | grep -q 'Result: PASS' || { echo "  ESPERADO PASS no self-test com o patch"; exit 1; }
SAIDA_CL2="$(cliente)"
echo "$SAIDA_CL2" | grep -E '^listTools (FAIL|OK)' | head -1
echo "$SAIDA_CL2" | grep -q '^listTools OK' || { echo "  ESPERADO listTools OK com o patch"; exit 1; }

echo
echo "VERIFICAÇÃO JS OK — upstream: self-test FAIL e cliente SDK FAIL; com o patch: PASS e OK."
