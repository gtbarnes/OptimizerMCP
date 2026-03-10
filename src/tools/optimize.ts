import { runCommand, detectAvailableTools, compressWithDistill, shellEscape, MAX_SHELL_PIPE_BYTES } from "../utils/subprocess.js";

export interface OptimizationResult {
  optimized_content: string;
  original_token_estimate: number;
  optimized_token_estimate: number;
  savings_percent: number;
  tools_used: string[];
  suggestions: string[];
}

let _cachedTools: Awaited<ReturnType<typeof detectAvailableTools>> | null = null;

async function getTools() {
  if (!_cachedTools) {
    _cachedTools = await detectAvailableTools();
  }
  return _cachedTools;
}

/** Invalidate the tool detection cache (call when tools may have changed). */
export function invalidateToolsCache(): void {
  _cachedTools = null;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function optimizeContext(
  input: string,
  options: { filePaths?: string[]; cwd?: string; contentType?: string } = {}
): Promise<OptimizationResult> {
  const { cwd = process.cwd(), contentType } = options;
  const tools = await getTools();
  const toolsUsed: string[] = [];
  const suggestions: string[] = [];
  let content = input;
  const originalTokens = estimateTokens(content);

  // If file paths are provided, try to use codebase-memory-mcp or SymDex
  if (options.filePaths && options.filePaths.length > 0) {
    if (tools.symdex) {
      // Use SymDex to get symbol-level info instead of full files
      const symbolResults = await getSymdexInfo(options.filePaths, cwd);
      if (symbolResults) {
        content = symbolResults;
        toolsUsed.push("symdex");
      }
    } else if (tools.codebaseMemory) {
      suggestions.push(
        "codebase-memory-mcp is available but should be used as a separate MCP server. " +
        "Ensure it's configured in your Codex config.toml."
      );
    } else {
      suggestions.push(
        "Install SymDex (pip install symdex) or codebase-memory-mcp for up to 97-99% " +
        "token reduction on code exploration."
      );
    }
  }

  // Determine if content should be treated as CLI output
  const isCliOutput = contentType === "cli_output" || contentType === "logs" ||
    (contentType !== "code" && contentType !== "text" && looksLikeCliOutput(content));

  // Apply RTK-style compression for CLI output
  if (tools.rtk && isCliOutput) {
    const compressed = await compressWithRtk(content, cwd);
    if (compressed && estimateTokens(compressed) < estimateTokens(content)) {
      content = compressed;
      toolsUsed.push("rtk");
    }
  } else if (tools.tokf && isCliOutput) {
    // tokf as fallback
    const compressed = await compressWithTokf(content, cwd);
    if (compressed && estimateTokens(compressed) < estimateTokens(content)) {
      content = compressed;
      toolsUsed.push("tokf");
    }
  }

  // Semantic compression via Distill or Ollama (best results for CLI output)
  if ((tools.distill || tools.ollama) && isCliOutput && estimateTokens(content) > 200) {
    const compressed = await compressWithDistill(content, "extract key information, errors, and results", { predetectedTools: tools });
    if (compressed.success && estimateTokens(compressed.output) < estimateTokens(content)) {
      content = compressed.output;
      toolsUsed.push(compressed.tool);
    }
  }

  // Always apply basic compression
  content = applyBasicCompression(content);
  toolsUsed.push("basic-compression");

  const optimizedTokens = estimateTokens(content);
  const savingsPercent =
    originalTokens > 0
      ? Math.round(((originalTokens - optimizedTokens) / originalTokens) * 100)
      : 0;

  // Generate suggestions
  if (!tools.symdex && !tools.codebaseMemory) {
    suggestions.push(
      "No code indexing tools detected. Install SymDex or codebase-memory-mcp for major savings."
    );
  }
  if (!tools.rtk && !tools.tokf) {
    suggestions.push(
      "No CLI output compressors detected. Install RTK or tokf for 60-90% savings on command output."
    );
  }
  if (!tools.distill && !tools.ollama) {
    suggestions.push(
      "No semantic compressor detected. Install Ollama (brew install ollama) + Distill (npm i -g @samuelfaj/distill) for 95-99% savings via LLM-based compression."
    );
  }

  return {
    optimized_content: content,
    original_token_estimate: originalTokens,
    optimized_token_estimate: optimizedTokens,
    savings_percent: savingsPercent,
    tools_used: toolsUsed,
    suggestions,
  };
}

function looksLikeCliOutput(text: string): boolean {
  const indicators = [
    /^\s*\$/m, // shell prompts
    /^(PASS|FAIL|ERROR|WARNING|INFO)/m,
    /\d+\s+(passing|failing|pending)/i,
    /^(\s*(modified|deleted|new file|renamed):)/m, // git status
    /^(commit|Author:|Date:)/m, // git log
    /^[\w/]+\.\w+:\d+/m, // file:line references
  ];
  return indicators.some((p) => p.test(text));
}

async function getSymdexInfo(filePaths: string[], cwd: string): Promise<string | null> {
  try {
    // Use symdex CLI to get file outlines instead of full content
    const pathList = filePaths.join(",");
    const result = await runCommand(
      "symdex",
      ["search", "--files", pathList, "--format", "compact"],
      { cwd, timeoutMs: 10_000 }
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // Fall through
  }
  return null;
}

async function compressWithRtk(content: string, _cwd: string): Promise<string | null> {
  if (content.length >= MAX_SHELL_PIPE_BYTES) return null; // too large for shell arg
  try {
    // RTK filters piped input — pipe content through rtk via shell
    const escaped = shellEscape(content);
    const result = await runCommand(
      "sh",
      ["-c", `printf '%s' ${escaped} | rtk proxy cat`],
      { timeoutMs: 10_000 }
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // Fall through
  }
  return null;
}

async function compressWithTokf(content: string, _cwd: string): Promise<string | null> {
  if (content.length >= MAX_SHELL_PIPE_BYTES) return null; // too large for shell arg
  try {
    // tokf filters piped input — pipe content through tokf via shell
    const escaped = shellEscape(content);
    const result = await runCommand(
      "sh",
      ["-c", `printf '%s' ${escaped} | tokf run cat`],
      { timeoutMs: 10_000 }
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // Fall through
  }
  return null;
}

function applyBasicCompression(text: string): string {
  let result = text;

  // Remove excessive blank lines (3+ → 1)
  result = result.replace(/\n{3,}/g, "\n\n");

  // Remove trailing whitespace on each line
  result = result.replace(/[ \t]+$/gm, "");

  // Collapse repeated log-style lines (keep first + count)
  const lines = result.split("\n");
  const compressed: string[] = [];
  let repeatCount = 0;
  let lastLine = "";

  for (const line of lines) {
    if (line === lastLine && line.trim().length > 0) {
      repeatCount++;
    } else {
      if (repeatCount > 0) {
        compressed.push(`  ... (repeated ${repeatCount} more times)`);
        repeatCount = 0;
      }
      compressed.push(line);
      lastLine = line;
    }
  }
  if (repeatCount > 0) {
    compressed.push(`  ... (repeated ${repeatCount} more times)`);
  }

  return compressed.join("\n");
}

export async function getProjectSummary(cwd: string): Promise<string> {
  const tools = await getTools();
  const parts: string[] = ["=== Project Summary ==="];

  // Try SymDex for repo outline
  if (tools.symdex) {
    try {
      const result = await runCommand("symdex", ["outline", "--format", "compact"], {
        cwd,
        timeoutMs: 10_000,
      });
      if (result.exitCode === 0 && result.stdout.trim()) {
        parts.push("\n--- Codebase Structure (via SymDex) ---");
        parts.push(result.stdout.trim());
        return parts.join("\n");
      }
    } catch {
      // Fall through
    }
  }

  // Fallback: basic directory listing (compressed)
  try {
    const result = await runCommand("find", [".", "-maxdepth", "3", "-type", "f", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"], {
      cwd,
      timeoutMs: 5_000,
    });
    if (result.exitCode === 0) {
      const files = result.stdout.trim().split("\n").sort().slice(0, 50);
      parts.push(`\n--- File Structure (${files.length} files shown) ---`);
      parts.push(files.join("\n"));
    }
  } catch {
    parts.push("\n(Could not enumerate project files)");
  }

  return parts.join("\n");
}
