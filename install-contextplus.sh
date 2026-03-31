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

cd "$ROOT_DIR"

echo "Installing Context+ dependencies..."
npm install

echo "Building Context+..."
npm run build

echo "Linking local contextplus CLI..."
npm link

if ! command -v contextplus >/dev/null 2>&1; then
  echo "FATAL: npm link succeeded but contextplus is not on PATH" >&2
  exit 1
fi

LINK_TARGET="$(readlink -f "$(command -v contextplus)")"
EXPECTED_TARGET="$ROOT_DIR/build/index.js"
if [ "$LINK_TARGET" != "$EXPECTED_TARGET" ]; then
  echo "FATAL: linked contextplus points to $LINK_TARGET, expected $EXPECTED_TARGET" >&2
  exit 1
fi

echo "Verifying linked CLI..."
contextplus tree "$ROOT_DIR" >/dev/null

echo "Context+ installed locally."
echo "CLI: $(command -v contextplus)"
