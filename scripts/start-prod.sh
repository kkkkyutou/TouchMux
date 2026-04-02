#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

# 防止 smoke/dev 会话残留的环境变量污染生产启动。
while IFS='=' read -r key _; do
  if [[ "$key" == TOUCHMUX_* ]]; then
    unset "$key"
  fi
done < <(env)

# 某些 tmux 会话可能继承到临时 HOME（例如 /tmp/...），这里强制回到当前用户真实 home。
REAL_HOME="$(getent passwd "$(id -un)" | cut -d: -f6 || true)"
if [[ -n "${REAL_HOME}" ]]; then
  export HOME="$REAL_HOME"
fi

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
