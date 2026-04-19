#!/usr/bin/env bash
###
 # @Author: bifang
 # @Date: 2026-04-16 23:49:34
 # @LastEditors: Do not edit
 # @LastEditTime: 2026-04-17 01:11:20
 # @FilePath: /codex-provider-sync-main/gui.sh
### 
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi

if command -v nvm >/dev/null 2>&1; then
  nvm use 24 >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node，请先安装 Node.js（建议 v24.x，最低 v22.x）。"
  exit 1
fi

node_major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
if [ "$node_major" -lt 24 ]; then
  echo "当前 Node.js 版本为 $(node -v)，本项目要求 Node.js >= v24。"
  echo "如果你用 nvm：先执行 'nvm install 24 && nvm use 24'，再运行 ./gui.sh"
  exit 1
fi

if node --disable-warning=ExperimentalWarning -e "" >/dev/null 2>&1; then
  node --disable-warning=ExperimentalWarning src/cli.js gui
else
  node src/cli.js gui
fi
