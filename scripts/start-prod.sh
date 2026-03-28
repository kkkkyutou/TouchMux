#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

if [[ ! -f ".env" ]]; then
  echo "缺少 .env，先执行: cp .env.example .env"
  exit 1
fi

if [[ ! -d "node_modules" ]]; then
  echo "未检测到 node_modules，先安装依赖"
  npm install
fi

npm run build
exec node backend/dist/server.js
