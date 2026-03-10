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
}> {
  const [claude, codex, opencode, rtk, tokf, symdex, codebaseMemory] = await Promise.all([
    commandExists("claude"),
    commandExists("codex"),
    commandExists("opencode"),
    commandExists("rtk"),
    commandExists("tokf"),
    commandExists("symdex"),
    commandExists("codebase-memory-mcp"),
  ]);

  return { claude, codex, opencode, rtk, tokf, symdex, codebaseMemory };
}
