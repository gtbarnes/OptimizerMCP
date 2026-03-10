import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

// ── Expand PATH for MCP subprocess environments ──────────────────────
// When Codex (or any MCP host) spawns us, PATH is often minimal.
// We add well-known tool locations so `which` can find everything.
const EXTRA_PATHS = [
  "/opt/homebrew/bin",           // macOS Homebrew (Apple Silicon)
  "/usr/local/bin",              // macOS Homebrew (Intel) / Linux standard
  `${homedir()}/.cargo/bin`,     // Rust / cargo (RTK, tokf)
  `${homedir()}/.local/bin`,     // pip --user installs (SymDex)
  `${homedir()}/go/bin`,         // Go binaries
  "/usr/local/go/bin",           // Go standard
  `${homedir()}/.npm-global/bin`, // npm global (alternate prefix)
];

const currentPath = process.env.PATH ?? "";
const pathsToAdd = EXTRA_PATHS.filter(
  (p) => !currentPath.includes(p) && existsSync(p)
);
if (pathsToAdd.length > 0) {
  process.env.PATH = [...pathsToAdd, currentPath].join(":");
}

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<SubprocessResult> {
  const { cwd, timeoutMs = 120_000, env } = options;

  try {
    const result = await execFileAsync(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : undefined,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    const result = await runCommand("which", [command], { timeoutMs: 5_000 });
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function detectAvailableTools(): Promise<{
  claude: boolean;
  codex: boolean;
  opencode: boolean;
  rtk: boolean;
  tokf: boolean;
  symdex: boolean;
  codebaseMemory: boolean;
  ollama: boolean;
  distill: boolean;
}> {
  const [claude, codex, opencode, rtk, tokf, symdex, codebaseMemory, ollama, distill] = await Promise.all([
    commandExists("claude"),
    commandExists("codex"),
    commandExists("opencode"),
    commandExists("rtk"),
    commandExists("tokf"),
    commandExists("symdex"),
    commandExists("codebase-memory-mcp"),
    commandExists("ollama"),
    commandExists("distill"),
  ]);

  return { claude, codex, opencode, rtk, tokf, symdex, codebaseMemory, ollama, distill };
}

/** Escape content for safe use in a shell single-quote context */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Max bytes for content piped via `sh -c "printf '%s' $escaped | ..."`.
 * Stay well under macOS ARG_MAX (~262144) to avoid silent failures.
 */
export const MAX_SHELL_PIPE_BYTES = 200_000;

/**
 * Call a local Ollama model. Returns the text response.
 * Used for task decomposition (parallel_delegate) and context compression (optimize_context).
 */
export async function callOllama(
  prompt: string,
  options: { model?: string; timeoutMs?: number } = {}
): Promise<{ success: boolean; output: string; error?: string }> {
  const { model = "qwen3:1.7b", timeoutMs = 30_000 } = options;
  const result = await runCommand("ollama", ["run", model, prompt], { timeoutMs });

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: "",
      error: `Ollama exited with code ${result.exitCode}: ${result.stderr}`,
    };
  }

  return {
    success: true,
    output: result.stdout.trim(),
  };
}

/**
 * Compress content using the Distill CLI (pipes content through local LLM).
 * Falls back to raw Ollama if Distill isn't installed.
 */
export async function compressWithDistill(
  content: string,
  query: string,
  options: { timeoutMs?: number; predetectedTools?: Awaited<ReturnType<typeof detectAvailableTools>> } = {}
): Promise<{ success: boolean; output: string; tool: string }> {
  const { timeoutMs = 30_000 } = options;
  const tools = options.predetectedTools ?? await detectAvailableTools();

  // Prefer Distill CLI (purpose-built for this)
  if (tools.distill && content.length < MAX_SHELL_PIPE_BYTES) {
    // Distill reads from stdin, so we use sh -c to pipe
    const escapedContent = shellEscape(content);
    const escapedQuery = shellEscape(query);
    const result = await runCommand(
      "sh",
      ["-c", `printf '%s' ${escapedContent} | distill ${escapedQuery}`],
      { timeoutMs }
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      return { success: true, output: result.stdout.trim(), tool: "distill" };
    }
  }

  // Fallback: raw Ollama with compression prompt
  if (tools.ollama) {
    const compressionPrompt =
      `Compress the following content into a concise summary that preserves all key information. ` +
      `Focus on: ${query}\n\n---\n${content.slice(0, 8000)}`; // Cap input to avoid overwhelming small model
    const result = await callOllama(compressionPrompt, { timeoutMs });
    if (result.success) {
      return { success: true, output: result.output, tool: "ollama" };
    }
  }

  return { success: false, output: content, tool: "none" };
}
