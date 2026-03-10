#!/usr/bin/env bash
set -euo pipefail

# OptimizerMCP Updater
# Pull latest changes and rebuild.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== OptimizerMCP Update ==="

echo "[1/3] Pulling latest changes..."
git pull --ff-only

echo ""
echo "[2/3] Installing dependencies..."
npm install --production=false 2>&1 | tail -1

echo ""
echo "[3/3] Building..."
npm run build 2>&1 | tail -1

echo ""
echo "=== Update complete ==="
echo "Restart Codex to pick up changes."
