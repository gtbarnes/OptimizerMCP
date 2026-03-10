import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

/**
 * Call a local Ollama model. Returns the text response.
 * Used for task decomposition (parallel_delegate) and context compression (optimize_context).
 */
export async function callOllama(
  prompt: string,
  options: { model?: string; timeoutMs?: number } = {}
): Promise<{ success: boolean; output: string; error?: string }> {
  const { model = "qwen3:2b", timeoutMs = 30_000 } = options;
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
  options: { timeoutMs?: number } = {}
): Promise<{ success: boolean; output: string; tool: string }> {
  const { timeoutMs = 30_000 } = options;
  const tools = await detectAvailableTools();

  // Prefer Distill CLI (purpose-built for this)
  if (tools.distill) {
    // Distill reads from stdin, so we use sh -c to pipe
    const result = await runCommand(
      "sh",
      ["-c", `echo ${JSON.stringify(content)} | distill ${JSON.stringify(query)}`],
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
