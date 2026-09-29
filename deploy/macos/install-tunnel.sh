#!/usr/bin/env bash
# Instala o túnel persistente (autossh + LaunchAgent) para o coroner remoto.
# Uso: ./install-tunnel.sh [host-ssh] [porta]
# O host deve existir no ~/.ssh/config (ex.: win-autopsy) apontando para a máquina do Autopsy.
set -euo pipefail

HOST="${1:-win-autopsy}"
PORT="${2:-3123}"
LABEL="com.${USER}.autossh-autopsy"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

command -v autossh >/dev/null 2>&1 || brew install autossh
AUTOSSH_BIN="$(command -v autossh)"

if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" true 2>/dev/null; then
  echo "aviso: chave SSH para '$HOST' nao autenticou (siga o deploy/README.md, secao 1)" >&2
fi

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__HOST__|$HOST|g" -e "s|__PORT__|$PORT|g" -e "s|__LABEL__|$LABEL|g" \
  "$HERE/com.autossh-autopsy.plist.template" > "$PLIST"
# caminho do autossh pode variar (Apple Silicon usa /opt/homebrew/bin)
sed -i '' "s|/usr/local/bin/autossh|$AUTOSSH_BIN|" "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 4

launchctl print "gui/$(id -u)/$LABEL" | grep -E 'state =' || true
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "tunel ativo: 127.0.0.1:$PORT -> $HOST:127.0.0.1:$PORT"
else
  echo "tunel NAO subiu; veja /tmp/autossh-autopsy.err" >&2
  exit 1
fi
