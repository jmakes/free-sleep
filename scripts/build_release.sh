#!/bin/bash
# Build server dist/ and app → server/public/ for installable / rsync deploys.
# Run from a developer machine (not on the Pod).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Free Sleep release build"
echo "    root: $ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required on PATH"
  exit 1
fi

NODE_VERSION="$(node -v | sed 's/^v//')"
echo "    node: v$NODE_VERSION"

echo ""
echo "==> Installing server dependencies (if needed)"
cd "$ROOT_DIR/server"
if [ ! -d node_modules ]; then
  npm ci
else
  echo "    server/node_modules present — skipping npm ci"
fi

echo ""
echo "==> Generating Prisma client"
npm run generate:local 2>/dev/null || npm run generate || true

echo ""
echo "==> Building server (tsc, no Sentry upload)"
npm run build:pr
# JSON imports are loaded at runtime; ensure dist has the latest serverInfo.json
cp -f src/serverInfo.json dist/serverInfo.json
echo "    wrote server/dist/serverInfo.json"

echo ""
echo "==> Installing app dependencies (if needed)"
cd "$ROOT_DIR/app"
if [ ! -d node_modules ]; then
  npm ci
else
  echo "    app/node_modules present — skipping npm ci"
fi

echo ""
echo "==> Building app into server/public/"
npm run build:pr

echo ""
echo -e "\033[0;32mRelease build complete.\033[0m"
echo "  server JS:  server/dist/"
echo "  web UI:     server/public/"
echo ""
echo "Next:"
echo "  - Commit dist/public if you want installer-from-GitHub to pick them up"
echo "  - Or deploy without committing:  ./scripts/deploy_rsync.sh root@POD_IP"
