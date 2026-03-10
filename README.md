# OptimizerMCP

Intelligent token optimizer and model router for [Codex](https://openai.com/codex). Routes tasks across Claude, Codex, and Z.AI/GLM services based on complexity, quota, and cost.

## What It Does

- **Classifies tasks** by complexity (trivial → architectural) without using an LLM
- **Routes to the cheapest capable model** across three services
- **Tracks usage** against plan quotas (5-hour windows, weekly limits)
- **Delegates work** across services with automatic fallback
- **Compresses context** using external optimization tools (if installed)

## Install

```bash
git clone https://github.com/gtbarnes/OptimizerMCP.git
cd OptimizerMCP
./install.sh
```

This installs dependencies, builds the project, and configures Codex to load the MCP server.

## Update

```bash
cd OptimizerMCP
./update.sh
```

## Optional External Tools

OptimizerMCP can integrate with the following **third-party tools** to further reduce token usage. These are separate, independently developed projects — OptimizerMCP does not include or redistribute their code. It simply detects whether they are installed on your system and invokes them via CLI if available.

- **[RTK (Rust Token Killer)](https://github.com/reachingforthejack/rtk)** — CLI output compression (60-90% token savings)
- **[tokf](https://github.com/tokf-project/tokf)** — Token output filter
- **[SymDex](https://github.com/symdex-project/symdex)** — Symbol-level code indexer (up to 97% savings on code lookups)
- **[codebase-memory-mcp](https://github.com/nicobailey-mcp/codebase-memory-mcp)** — Graph-based codebase memory MCP server
- **[OpenCode](https://github.com/anomalyhq/opencode)** — CLI for Z.AI/GLM model access

None of these are required. The server works without them and degrades gracefully.

## Environment Variables

| Variable | Purpose |
|---|---|
| `ZAI_API_KEY` | Direct Z.AI API access (alternative to OpenCode CLI) |
| `ZHIPU_API_KEY` | Alias for `ZAI_API_KEY` |

## License

[MIT](LICENSE)

## Acknowledgments

This project uses the [Model Context Protocol SDK](https://github.com/modelcontextprotocol/sdk) by Anthropic (MIT licensed), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (MIT), and [Zod](https://github.com/colinhacks/zod) (MIT).

Built with assistance from Claude (Anthropic).
