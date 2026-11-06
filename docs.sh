#!/usr/bin/env bash
# Copies the documents folder into Open WebUI's knowledge. Each folder inside documents becomes a
# knowledge collection; in a chat, type # to pick one. Run again whenever you change the folder.
# To run it every hour by itself, see the README ("Documents for Open WebUI").
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "Run ./setup.sh first."; exit 1; }
SUDO=""; [ "$(id -u)" != 0 ] && SUDO="sudo"
mkdir -p documents
$SUDO docker run --rm --network host \
  --user "$(stat -c %u documents):$(stat -c %g documents)" \
  --env-file .env -e DOCS_DIR=/documents \
  -v "$PWD/documents:/documents" -v "$PWD/scripts:/scripts:ro" \
  node:22-trixie-slim node /scripts/sync-docs.mjs
