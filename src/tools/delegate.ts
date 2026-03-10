import { runCommand, commandExists } from "../utils/subprocess.js";
import { recordUsage } from "../tracking/usage-store.js";
import type { ServiceType } from "../config/models.js";

export interface DelegationResult {
  success: boolean;
  output: string;
  error?: string;
  model_used: string;
  service_used: string;
  estimated_tokens: number;
}

export async function delegateTask(
  prompt: string,
  targetModel: string,
  targetService: ServiceType,
  options: {
    cwd?: string;
    timeoutMs?: number;
    fallbackModel?: string;
    fallbackService?: ServiceType;
  } = {}
): Promise<DelegationResult> {
  const { cwd = process.cwd(), timeoutMs = 120_000 } = options;

  let result = await dispatchToService(prompt, targetModel, targetService, cwd, timeoutMs);

  // Auto-fallback: if primary failed and we have a fallback, retry
  if (!result.success && options.fallbackModel && options.fallbackService) {
    const primaryError = result.error;
    result = await dispatchToService(
      prompt, options.fallbackModel, options.fallbackService, cwd, timeoutMs
    );
    if (result.success) {
      // Annotate that we used the fallback
      result.output = `[Fallback: ${targetModel}@${targetService} failed, used ${options.fallbackModel}@${options.fallbackService}]\n\n` +
        result.output;
    } else {
      // Both failed — include both errors
      result.error = `Primary (${targetModel}@${targetService}): ${primaryError}\n` +
        `Fallback (${options.fallbackModel}@${options.fallbackService}): ${result.error}`;
    }
  }

  const estimatedInputTokens = Math.ceil(prompt.length / 4);
  const estimatedOutputTokens = Math.ceil(result.output.length / 4);

  recordUsage({
    service: result.service_used as ServiceType,
    model: result.model_used,
    estimated_input_tokens: estimatedInputTokens,
    estimated_output_tokens: estimatedOutputTokens,
    task_complexity: "delegated",
  });

  result.estimated_tokens = estimatedInputTokens + estimatedOutputTokens;

  return result;
}

async function dispatchToService(
  prompt: string,
  model: string,
  service: ServiceType,
  cwd: string,
  timeoutMs: number
): Promise<DelegationResult> {
  switch (service) {
    case "claude":
      return await delegateToClaude(prompt, model, cwd, timeoutMs);
    case "codex":
      return await delegateToCodex(prompt, model, cwd, timeoutMs);
    case "zai":
      return await delegateToZai(prompt, model, cwd, timeoutMs);
    default:
      return {
        success: false,
        output: "",
        error: `Unknown service: ${service}`,
        model_used: model,
        service_used: service,
        estimated_tokens: 0,
      };
  }
}

async function delegateToClaude(
  prompt: string,
  model: string,
  cwd: string,
  timeoutMs: number
): Promise<DelegationResult> {
  const args = ["-p", "--output-format", "text", "--model", model, prompt];
  const result = await runCommand("claude", args, { cwd, timeoutMs });

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: "",
      error: `Claude exited with code ${result.exitCode}: ${result.stderr}`,
      model_used: model,
      service_used: "claude",
      estimated_tokens: 0,
    };
  }

  return {
    success: true,
    output: result.stdout.trim(),
    model_used: model,
    service_used: "claude",
    estimated_tokens: 0,
  };
}

async function delegateToCodex(
  prompt: string,
  model: string,
  cwd: string,
  timeoutMs: number
): Promise<DelegationResult> {
  const args = ["exec", "--model", model, "--full-auto", prompt];
  const result = await runCommand("codex", args, { cwd, timeoutMs });

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: "",
      error: `Codex exited with code ${result.exitCode}: ${result.stderr}`,
      model_used: model,
      service_used: "codex",
      estimated_tokens: 0,
    };
  }

  return {
    success: true,
    output: result.stdout.trim(),
    model_used: model,
    service_used: "codex",
    estimated_tokens: 0,
  };
}

/**
 * Delegate to Z.AI with cascading fallback:
 *   1. OpenCode CLI (preferred — handles auth natively via `opencode auth login`)
 *   2. Direct API via curl (if ZAI_API_KEY is set)
 *   3. Claude Code with Z.AI model names (if Claude is configured with Z.AI backend)
 */
async function delegateToZai(
  prompt: string,
  model: string,
  cwd: string,
  timeoutMs: number
): Promise<DelegationResult> {
  // 1. Try OpenCode CLI (preferred path)
  const hasOpenCode = await commandExists("opencode");
  if (hasOpenCode) {
    const result = await delegateToZaiViaOpenCode(prompt, model, cwd, timeoutMs);
    if (result.success) return result;
    // If OpenCode failed (e.g. not authenticated), fall through
  }

  // 2. Try direct API if key is available
  const apiKey = process.env.ZAI_API_KEY ?? process.env.ZHIPU_API_KEY;
  if (apiKey) {
    return await delegateToZaiApi(prompt, model, apiKey, timeoutMs);
  }

  // 3. Fallback: try Claude Code with Z.AI model names
  return await delegateToZaiViaClaude(prompt, model, cwd, timeoutMs);
}

async function delegateToZaiViaOpenCode(
  prompt: string,
  model: string,
  cwd: string,
  timeoutMs: number
): Promise<DelegationResult> {
  // OpenCode uses "zai/<model>" format for Z.AI models
  const qualifiedModel = model.startsWith("zai/") ? model : `zai/${model}`;
  const args = ["run", "-m", qualifiedModel, prompt];
  const result = await runCommand("opencode", args, { cwd, timeoutMs });

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: "",
      error: `OpenCode exited with code ${result.exitCode}: ${result.stderr}`,
      model_used: model,
      service_used: "zai",
      estimated_tokens: 0,
    };
  }

  return {
    success: true,
    output: result.stdout.trim(),
    model_used: model,
    service_used: "zai",
    estimated_tokens: 0,
  };
}

async function delegateToZaiApi(
  prompt: string,
  model: string,
  apiKey: string,
  timeoutMs: number
): Promise<DelegationResult> {
  const body = JSON.stringify({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const args = [
    "-s", "-X", "POST",
    "https://api.z.ai/api/anthropic/v1/messages",
    "-H", "Content-Type: application/json",
    "-H", `x-api-key: ${apiKey}`,
    "-H", "anthropic-version: 2023-06-01",
    "-d", body,
  ];

  const result = await runCommand("curl", args, { timeoutMs });

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: "",
      error: `Z.AI API call failed: ${result.stderr}`,
      model_used: model,
      service_used: "zai",
      estimated_tokens: 0,
    };
  }

  try {
    const response = JSON.parse(result.stdout);
    if (response.error) {
      return {
        success: false,
        output: "",
        error: `Z.AI API error: ${response.error.message ?? JSON.stringify(response.error)}`,
        model_used: model,
        service_used: "zai",
        estimated_tokens: 0,
      };
    }

    const text = response.content
      ?.map((c: { type: string; text?: string }) => c.text ?? "")
      .join("") ?? "";

    return {
      success: true,
      output: text,
      model_used: model,
      service_used: "zai",
      estimated_tokens: 0,
    };
  } catch {
    return {
      success: false,
      output: result.stdout,
      error: "Failed to parse Z.AI API response",
      model_used: model,
      service_used: "zai",
      estimated_tokens: 0,
    };
  }
}

async function delegateToZaiViaClaude(
  prompt: string,
  model: string,
  cwd: string,
  timeoutMs: number
): Promise<DelegationResult> {
  const args = ["-p", "--output-format", "text", "--model", model, prompt];
  const result = await runCommand("claude", args, { cwd, timeoutMs });

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: "",
      error: `Z.AI delegation failed. Install OpenCode (brew install anomalyco/tap/opencode) ` +
        `and run 'opencode auth login' to authenticate with Z.AI, or set ZAI_API_KEY env var.\n` +
        result.stderr,
      model_used: model,
      service_used: "zai",
      estimated_tokens: 0,
    };
  }

  return {
    success: true,
    output: result.stdout.trim(),
    model_used: model,
    service_used: "zai",
    estimated_tokens: 0,
  };
}
