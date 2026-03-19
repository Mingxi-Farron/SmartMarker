#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT_DIR/local-agent-mac"
DIST_DIR="$ROOT_DIR/dist"

mkdir -p "$DIST_DIR"

cd "$AGENT_DIR"

npm install
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:desktop

DMG_SOURCE="$(ls -t "$AGENT_DIR"/release/*.dmg | head -n 1)"
if [ -z "${DMG_SOURCE:-}" ]; then
  echo "No DMG produced in $AGENT_DIR/release"
  exit 1
fi

DMG_PATH="$DIST_DIR/SmartMarker.dmg"
cp -f "$DMG_SOURCE" "$DMG_PATH"
echo "DMG generated: $DMG_PATH"
