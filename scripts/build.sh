#!/bin/bash
# dsh-glm build: pnpm install（若缺依赖）→ tsc 编译 host（无 client 面板）。
# 自包含：不依赖 DSH_CHECKOUT，直接用本包 node_modules 的编译器。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -x node_modules/.bin/tsc ]; then
  echo "=== Installing dependencies ==="
  pnpm install --prefer-offline
fi

echo "=== Compiling host (src -> lib) ==="
node_modules/.bin/tsc -p tsconfig.json

echo "=== Build complete ==="
