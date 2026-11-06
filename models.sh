#!/usr/bin/env bash
# Adds, removes and tests AI models for llama.cpp. Run ./models.sh with no options for a menu.
#   ./models.sh tune     tries different numbers of threads and saves the fastest in .env
# See scripts/models.mjs for all commands. After a change, llama-swap is restarted so it sees it.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "Run ./setup.sh first."; exit 1; }
SUDO=""; [ "$(id -u)" != 0 ] && SUDO="sudo"
mkdir -p llm/models
TTY=""; [ -t 0 ] && [ -t 1 ] && TTY="-it"
PORT=$(grep -E '^LLM_PORT=' .env | cut -d= -f2 || true); PORT=${PORT:-8091}

node_run() {
  $SUDO docker run --rm $TTY --network host \
    --user "$(stat -c %u llm):$(stat -c %g llm)" \
    --env-file .env -e LLM_DIR=/llm -e "LLM_BENCH_URL=http://localhost:$PORT" -e "LLM_CORES=$(nproc)" \
    -v "$PWD/llm:/llm" -v "$PWD/scripts:/scripts:ro" \
    node:22-trixie-slim node /scripts/models.mjs "$@"
}

restart_swap() {
  if [ -n "$($SUDO docker ps -q -f name=^llama-swap$ 2>/dev/null)" ]; then
    echo "Restarting llama-swap so it sees the change..."
    $SUDO docker compose restart llama-swap >/dev/null
    for _ in $(seq 1 30); do curl -fsS -o /dev/null "http://localhost:$PORT/v1/models" 2>/dev/null && return 0; sleep 1; done
  fi
}

setenv() { # setenv KEY VALUE (replace or add)
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}

if [ "${1:-}" = tune ]; then
  shift
  echo "Finding the fastest number of threads for this computer. Nothing else should use the AI meanwhile."
  node_run tune-prepare "$@"
  restart_swap
  rm -f llm/tune-result.json
  node_run tune-run || true
  if [ -f llm/tune-result.json ]; then
    t=$(grep -o '"threads":[0-9]*' llm/tune-result.json | cut -d: -f2)
    tb=$(grep -o '"threadsBatch":[0-9]*' llm/tune-result.json | cut -d: -f2)
    setenv LLM_THREADS "$t"
    setenv LLM_THREADS_BATCH "$tb"
  fi
  rm -f llm/tune.json llm/tune-result.json
  node_run config
  restart_swap
  exit 0
fi

before=$(md5sum llm/llama-swap.yaml 2>/dev/null || true)
node_run "$@"
after=$(md5sum llm/llama-swap.yaml 2>/dev/null || true)
[ "$before" != "$after" ] && restart_swap
exit 0
