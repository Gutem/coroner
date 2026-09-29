#!/usr/bin/env bash
# coroner — servidor MCP read-only para cases do Autopsy
# Uso: ./start.sh [stdio|http] [porta]
set -euo pipefail

TRANSPORT="${1:-stdio}"
export AUTOPSY_CASES_DIR="${AUTOPSY_CASES_DIR:-$HOME/AutopsyCases}"

if ! command -v bun >/dev/null 2>&1; then
  echo "[erro] Bun não encontrado. Instale: https://bun.sh" >&2
  exit 1
fi

if [ "$TRANSPORT" = "http" ]; then
  exec bun run src/index.js --transport http --port "${2:-3123}"
else
  exec bun run src/index.js
fi
