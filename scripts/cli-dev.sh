#!/usr/bin/env bash
# Rebuild the command-line bundle for development (type-check, bundle, copy the Ray helper next to it).
# Usage (Git Bash): scripts/cli-dev.sh   then: .tools/node/node.exe dist-cli/depth-lidar.cjs help
set -e
cd "$(dirname "$0")/.."
export PATH="$PWD/.tools/node:$PATH"
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build --config vite.cli.config.ts 2>&1 | grep -a "built in\|rror" || true
cp electron/raydecode.ps1 electron/raydecode.cs dist-cli/
