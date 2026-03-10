#!/usr/bin/env bash
set -euo pipefail

# OptimizerMCP Installer
# Installs the MCP server and configures Codex to use it.
#
# Usage (from anywhere):
#   git clone https://github.com/gtbarnes/OptimizerMCP.git ~/OptimizerMCP && ~/OptimizerMCP/install.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_CONFIG_DIR="$HOME/.codex"
CODEX_CONFIG="$CODEX_CONFIG_DIR/config.toml"

echo "=== OptimizerMCP Installer ==="
echo "Project dir: $SCRIPT_DIR"
echo ""

# 1. Check prerequisites — find node even if not on PATH
echo "[1/5] Checking prerequisites..."

NODE_BIN=""
if command -v node &>/dev/null; then
  NODE_BIN="$(command -v node)"
elif [ -x /opt/homebrew/bin/node ]; then
  NODE_BIN="/opt/homebrew/bin/node"
elif [ -x /usr/local/bin/node ]; then
  NODE_BIN="/usr/local/bin/node"
else
  echo "ERROR: Node.js not found. Install it first: https://nodejs.org"
  exit 1
fi

# Make sure npm is also available for the rest of the script
NODE_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIR:$PATH"

NODE_VERSION=$("$NODE_BIN" -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required (found $("$NODE_BIN" -v))"
  exit 1
fi
echo "  Node.js: $("$NODE_BIN" -v) at $NODE_BIN ✓"

if ! command -v codex &>/dev/null; then
  echo "  WARNING: Codex CLI not found — install it to use delegation features"
else
  echo "  Codex CLI: $(codex --version 2>/dev/null || echo 'installed') ✓"
fi

if ! command -v claude &>/dev/null; then
  echo "  WARNING: Claude CLI not found — install it to use delegation features"
else
  echo "  Claude CLI: installed ✓"
fi

# 2. Install dependencies
echo ""
echo "[2/5] Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --production=false 2>&1 | tail -1

# 3. Build
echo ""
echo "[3/5] Building TypeScript..."
npm run build 2>&1 | tail -1
echo "  Build output: $SCRIPT_DIR/build/index.js ✓"

# 4. Configure Codex
echo ""
echo "[4/5] Configuring Codex..."
mkdir -p "$CODEX_CONFIG_DIR"

# Remove any old optimizer config (in case path changed)
if grep -q 'mcp_servers.optimizer' "$CODEX_CONFIG" 2>/dev/null; then
  # Remove the old block so we can write the updated one
  sed -i.bak '/^\[mcp_servers\.optimizer\]/,/^$/d' "$CODEX_CONFIG"
  echo "  Replaced existing optimizer config"
fi

# Write config using the absolute path to the node binary we found
cat >> "$CODEX_CONFIG" <<EOF

[mcp_servers.optimizer]
command = "$NODE_BIN"
args = ["$SCRIPT_DIR/build/index.js"]
required = true
startup_timeout_sec = 15
EOF
echo "  Added [mcp_servers.optimizer] to $CODEX_CONFIG ✓"
echo "    command = $NODE_BIN"
echo "    args = $SCRIPT_DIR/build/index.js"

# 5. Install AGENTS.md
echo ""
echo "[5/5] Installing AGENTS.md..."
if [ -f "$CODEX_CONFIG_DIR/AGENTS.md" ]; then
  if grep -q 'classify_task' "$CODEX_CONFIG_DIR/AGENTS.md" 2>/dev/null; then
    echo "  AGENTS.md already contains optimizer instructions — skipping"
  else
    echo ""
    echo "  WARNING: ~/.codex/AGENTS.md already exists with other content."
    echo "  You may want to manually merge the optimizer instructions from:"
    echo "    $SCRIPT_DIR/AGENTS.md"
  fi
else
  cp "$SCRIPT_DIR/AGENTS.md" "$CODEX_CONFIG_DIR/AGENTS.md"
  echo "  Installed AGENTS.md to $CODEX_CONFIG_DIR/AGENTS.md ✓"
fi

# Done
echo ""
echo "=== Installation complete ==="
echo ""
echo "The optimizer will load automatically next time you start Codex."
echo ""
echo "To update later:  cd $SCRIPT_DIR && ./update.sh"
echo ""
echo "Optional environment variables:"
echo "  ZAI_API_KEY=<key>    — Enable direct Z.AI API delegation"
echo "  ZHIPU_API_KEY=<key>  — Alternative Z.AI key variable"
echo ""
echo "To verify: start Codex and ask it to 'classify this task: fix a typo'"
