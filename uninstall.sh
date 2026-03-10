#!/usr/bin/env bash
set -euo pipefail

# OptimizerMCP Uninstaller
# Removes the MCP server config from Codex (does not delete project files).

CODEX_CONFIG="$HOME/.codex/config.toml"
AGENTS_MD="$HOME/.codex/AGENTS.md"

echo "=== OptimizerMCP Uninstaller ==="

if [ -f "$CODEX_CONFIG" ]; then
  # Remove the [mcp_servers.optimizer] block (and its keys)
  if grep -q 'mcp_servers.optimizer' "$CODEX_CONFIG" 2>/dev/null; then
    # Use sed to remove the block — from [mcp_servers.optimizer] to next blank line or EOF
    sed -i.bak '/^\[mcp_servers\.optimizer\]/,/^$/d' "$CODEX_CONFIG"
    echo "Removed [mcp_servers.optimizer] from $CODEX_CONFIG"
    echo "Backup saved to ${CODEX_CONFIG}.bak"
  else
    echo "No optimizer config found in $CODEX_CONFIG"
  fi
fi

if [ -f "$AGENTS_MD" ]; then
  if grep -q 'classify_task' "$AGENTS_MD" 2>/dev/null; then
    echo ""
    echo "NOTE: $AGENTS_MD contains optimizer instructions."
    echo "Remove it manually if you no longer need it:"
    echo "  rm $AGENTS_MD"
  fi
fi

echo ""
echo "Uninstall complete. Project files were not removed."
echo "To fully delete: rm -rf <project-dir>"
