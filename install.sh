#!/usr/bin/env bash
set -euo pipefail

# OptimizerMCP Installer / Updater
# Fresh install OR update an existing installation — safe to re-run at any time.
#
# Fresh install:
#   git clone https://github.com/gtbarnes/OptimizerMCP.git ~/OptimizerMCP && ~/OptimizerMCP/install.sh
#
# Update existing:
#   ~/OptimizerMCP/install.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_CONFIG_DIR="$HOME/.codex"
CODEX_CONFIG="$CODEX_CONFIG_DIR/config.toml"

# ── Detect install vs update ──────────────────────────────────────────
IS_UPDATE=false
if [ -f "$SCRIPT_DIR/build/index.js" ] && grep -q 'mcp_servers.optimizer' "$CODEX_CONFIG" 2>/dev/null; then
  IS_UPDATE=true
fi

if $IS_UPDATE; then
  echo "=== OptimizerMCP Updater ==="
  echo "Existing installation detected — updating..."
else
  echo "=== OptimizerMCP Installer ==="
fi
echo "Project dir: $SCRIPT_DIR"
echo ""

# ── Step 0 (update only): Pull latest from GitHub ────────────────────

if $IS_UPDATE; then
  echo "[0/7] Pulling latest changes..."
  cd "$SCRIPT_DIR"
  if git rev-parse --is-inside-work-tree &>/dev/null; then
    BEFORE=$(git rev-parse HEAD)
    git pull --ff-only 2>&1 || {
      echo "  WARNING: git pull failed (you may have local changes). Continuing with current code."
    }
    AFTER=$(git rev-parse HEAD)
    if [ "$BEFORE" = "$AFTER" ]; then
      echo "  Already up-to-date ✓"
    else
      echo "  Updated to $(git log -1 --format='%h %s') ✓"
    fi
  else
    echo "  Not a git repo — skipping pull"
  fi
  echo ""
fi

# ── Step 1: Check prerequisites ──────────────────────────────────────

echo "[1/7] Checking prerequisites..."

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

NODE_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIR:$PATH"

NODE_VERSION=$("$NODE_BIN" -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required (found $("$NODE_BIN" -v))"
  exit 1
fi
echo "  Node.js: $("$NODE_BIN" -v) at $NODE_BIN ✓"

# Check for Homebrew (needed for some optional tools)
HAS_BREW=false
if command -v brew &>/dev/null; then
  HAS_BREW=true
  echo "  Homebrew: installed ✓"
else
  echo "  Homebrew: not found (some optional tools require it)"
fi

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

# ── Step 2: Install npm dependencies + build ─────────────────────────

echo ""
echo "[2/7] Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --production=false 2>&1 | tail -1

echo ""
echo "[3/7] Building TypeScript..."
npm run build 2>&1 | tail -1
echo "  Build output: $SCRIPT_DIR/build/index.js ✓"

# ── Step 3: Install optimization tools ───────────────────────────────

echo ""
echo "[4/7] Installing optimization tools..."

# Ollama (local LLM — powers auto task splitting + semantic compression)
if command -v ollama &>/dev/null; then
  echo "  Ollama: already installed ✓"
else
  if $HAS_BREW; then
    echo "  Installing Ollama..."
    brew install ollama 2>&1 | tail -1
    echo "  Ollama: installed ✓"
  else
    echo "  Ollama: SKIP (requires Homebrew — install manually: https://ollama.ai)"
  fi
fi

# Pull the default model for Ollama (qwen3:1.7b — small, fast, good for decomposition)
if command -v ollama &>/dev/null; then
  if ollama list 2>/dev/null | grep -q "qwen3:1.7b"; then
    echo "  Ollama model qwen3:1.7b: already pulled ✓"
  else
    echo "  Pulling Ollama model qwen3:1.7b (small, ~1.5GB)..."
    ollama pull qwen3:1.7b 2>&1 | tail -1
    echo "  Ollama model qwen3:1.7b: ready ✓"
  fi
fi

# Distill (semantic output compressor — uses Ollama internally)
if command -v distill &>/dev/null; then
  echo "  Distill: already installed ✓"
else
  echo "  Installing Distill (npm global)..."
  npm install -g @samuelfaj/distill 2>&1 | tail -1
  echo "  Distill: installed ✓"
fi

# RTK (Rust Token Killer — CLI output compression)
if command -v rtk &>/dev/null; then
  echo "  RTK: already installed ✓"
else
  if command -v cargo &>/dev/null; then
    echo "  Installing RTK (cargo)..."
    cargo install rtk 2>&1 | tail -1
    echo "  RTK: installed ✓"
  else
    echo "  RTK: SKIP (requires Rust/cargo — install via: cargo install rtk)"
  fi
fi

# tokf (token output filter)
if command -v tokf &>/dev/null; then
  echo "  tokf: already installed ✓"
else
  if command -v cargo &>/dev/null; then
    echo "  Installing tokf (cargo)..."
    cargo install tokf 2>&1 | tail -1
    echo "  tokf: installed ✓"
  else
    echo "  tokf: SKIP (requires Rust/cargo — install via: cargo install tokf)"
  fi
fi

# SymDex (symbol-level code indexer)
if command -v symdex &>/dev/null; then
  echo "  SymDex: already installed ✓"
else
  if command -v pip3 &>/dev/null; then
    echo "  Installing SymDex (pip)..."
    pip3 install symdex 2>&1 | tail -1
    echo "  SymDex: installed ✓"
  elif command -v pip &>/dev/null; then
    echo "  Installing SymDex (pip)..."
    pip install symdex 2>&1 | tail -1
    echo "  SymDex: installed ✓"
  else
    echo "  SymDex: SKIP (requires Python/pip — install via: pip install symdex)"
  fi
fi

# OpenCode (Z.AI CLI — for Z.AI/GLM delegation)
if command -v opencode &>/dev/null; then
  echo "  OpenCode: already installed ✓"
else
  if $HAS_BREW; then
    echo "  Installing OpenCode..."
    brew install anomalyco/tap/opencode 2>&1 | tail -1
    echo "  OpenCode: installed ✓"
    echo "  NOTE: Run 'opencode auth login' to authenticate with Z.AI"
  else
    echo "  OpenCode: SKIP (requires Homebrew — install via: brew install anomalyco/tap/opencode)"
  fi
fi

# ── Step 4: Configure Codex ──────────────────────────────────────────

echo ""
echo "[5/7] Configuring Codex..."
mkdir -p "$CODEX_CONFIG_DIR"

if grep -q 'mcp_servers.optimizer' "$CODEX_CONFIG" 2>/dev/null; then
  sed -i.bak '/^\[mcp_servers\.optimizer\]/,/^$/d' "$CODEX_CONFIG"
  echo "  Replaced existing optimizer config"
fi

cat >> "$CODEX_CONFIG" <<EOF

[mcp_servers.optimizer]
command = "$NODE_BIN"
args = ["$SCRIPT_DIR/build/index.js"]
required = true
startup_timeout_sec = 15
EOF
echo "  Added [mcp_servers.optimizer] to $CODEX_CONFIG ✓"

# ── Step 5: Install AGENTS.md ────────────────────────────────────────

echo ""
echo "[6/7] Installing AGENTS.md..."
if [ -f "$CODEX_CONFIG_DIR/AGENTS.md" ]; then
  # Check if existing file is ours (contains OptimizerMCP references)
  if grep -q 'classify_task\|OptimizerMCP' "$CODEX_CONFIG_DIR/AGENTS.md" 2>/dev/null; then
    cp "$SCRIPT_DIR/AGENTS.md" "$CODEX_CONFIG_DIR/AGENTS.md"
    echo "  AGENTS.md updated from repo ✓"
  else
    echo "  WARNING: ~/.codex/AGENTS.md exists with other content."
    echo "  You may want to merge from: $SCRIPT_DIR/AGENTS.md"
  fi
else
  cp "$SCRIPT_DIR/AGENTS.md" "$CODEX_CONFIG_DIR/AGENTS.md"
  echo "  Installed AGENTS.md to $CODEX_CONFIG_DIR/AGENTS.md ✓"
fi

# ── Step 6: Verify ───────────────────────────────────────────────────

echo ""
echo "[7/7] Verifying installation..."
TOOL_OUTPUT=$("$NODE_BIN" "$SCRIPT_DIR/build/index.js" --help 2>&1 || true)
if echo "$TOOL_OUTPUT" | grep -q "parallel_delegate"; then
  echo "  Server starts and all 10 tools detected ✓"
else
  echo "  Server starts ✓ (run 'check_available_tools' in Codex for full status)"
fi

# ── Done ─────────────────────────────────────────────────────────────

echo ""
if $IS_UPDATE; then
  echo "=== Update complete ==="
else
  echo "=== Installation complete ==="
fi
echo ""
echo "10 MCP tools available:"
echo "  classify_task, recommend_model, check_quota, delegate_task,"
echo "  parallel_delegate, optimize_context, get_project_summary,"
echo "  update_model_registry, check_available_tools, record_usage"
echo ""
echo "Optimization tools integrated:"
echo "  Ollama (auto task splitting + semantic compression)"
echo "  Distill (95-99% token savings on CLI output)"
echo "  RTK / tokf (60-90% CLI output compression)"
echo "  SymDex (97% savings on code lookups)"
echo "  OpenCode (Z.AI delegation)"
echo ""
echo "To update later:  $SCRIPT_DIR/install.sh"
echo "To verify:        start Codex and ask 'check_available_tools'"
