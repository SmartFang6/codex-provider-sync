#!/usr/bin/env bash
###
 # @Author: bifang
 # @Date: 2026-04-13 11:11:04
 # @LastEditors: Do not edit
 # @LastEditTime: 2026-04-13 11:11:05
 # @FilePath: /codex-provider-sync/gui.sh
### 
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if ! command -v nvm >/dev/null 2>&1; then
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
  elif [ -s "/opt/homebrew/opt/nvm/nvm.sh" ]; then
    . "/opt/homebrew/opt/nvm/nvm.sh"
  elif [ -s "/usr/local/opt/nvm/nvm.sh" ]; then
    . "/usr/local/opt/nvm/nvm.sh"
  else
    echo "nvm 未找到：请先安装 nvm，或在当前 shell 中手动 source nvm.sh" >&2
    exit 1
  fi
fi

nvm use 24 >/dev/null
node '/Volumes/INFINITY/项目/zy/codex-provider-sync/src/cli.js' gui
