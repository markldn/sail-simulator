#!/usr/bin/env bash
#
# run.sh — start the sailboat simulator's local web server.
#
# Usage:
#   ./run.sh            # dev server with hot-reload (default)
#   ./run.sh preview    # serve a production build (runs `build` first)
#
set -euo pipefail

# Always operate from the project root (the dir this script lives in), so it
# works no matter where it's invoked from.
cd "$(dirname "$0")"

# Install dependencies on first run (or after they're cleared).
if [ ! -d node_modules ]; then
  echo "Installing dependencies…"
  npm install
fi

mode="${1:-dev}"

case "$mode" in
  dev)
    echo "Starting dev server (hot-reload)…  Ctrl-C to stop."
    exec npm run dev
    ;;
  preview)
    echo "Building for production…"
    npm run build
    echo "Serving the production build…  Ctrl-C to stop."
    exec npm run preview
    ;;
  *)
    echo "Unknown mode: $mode" >&2
    echo "Usage: ./run.sh [dev|preview]" >&2
    exit 1
    ;;
esac
