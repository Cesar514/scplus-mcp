#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "FATAL: node is required" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "FATAL: npm is required" >&2
  exit 1
fi

if ! command -v pixi >/dev/null 2>&1; then
  echo "FATAL: pixi is required to build the Bubble Tea CLI" >&2
  exit 1
fi

cd "$ROOT_DIR"

echo "Installing scplus dependencies..."
npm install

echo "Building scplus-mcp..."
npm run build

echo "Building scplus-cli..."
npm run build:cli

echo "Linking local scplus commands..."
npm link

if ! command -v 'scplus-mcp' >/dev/null 2>&1; then
  echo "FATAL: npm link succeeded but scplus-mcp is not on PATH" >&2
  exit 1
fi

if ! command -v 'scplus-cli' >/dev/null 2>&1; then
  echo "FATAL: npm link succeeded but scplus-cli is not on PATH" >&2
  exit 1
fi

LINK_TARGET="$(readlink -f "$(command -v 'scplus-mcp')")"
EXPECTED_TARGET="$ROOT_DIR/build/index.js"
if [ "$LINK_TARGET" != "$EXPECTED_TARGET" ]; then
  echo "FATAL: linked scplus-mcp points to $LINK_TARGET, expected $EXPECTED_TARGET" >&2
  exit 1
fi

UI_LINK_TARGET="$(readlink -f "$(command -v 'scplus-cli')")"
EXPECTED_UI_TARGET="$ROOT_DIR/build/cli-launcher.js"
if [ "$UI_LINK_TARGET" != "$EXPECTED_UI_TARGET" ]; then
  echo "FATAL: linked scplus-cli points to $UI_LINK_TARGET, expected $EXPECTED_UI_TARGET" >&2
  exit 1
fi

echo "Verifying linked MCP CLI..."
'scplus-mcp' tree "$ROOT_DIR" >/dev/null

echo "Verifying linked human CLI..."
'scplus-cli' doctor --root "$ROOT_DIR" >/dev/null

echo "scplus installed locally."
echo "MCP CLI: $(command -v 'scplus-mcp')"
echo "Human CLI: $(command -v 'scplus-cli')"
