import { runCommand, commandExists, callOllama } from "../utils/subprocess.js";
import { recordUsage, getQuotaStatus } from "../tracking/usage-store.js";
import type { ServiceType } from "../config/models.js";
import { classifyTask } from "./classify.js";
import { routeTask } from "./route.js";

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
  const { cwd = process.cwd(), timeoutMs = 240_000 } = options;

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
  console.error(`[OptimizerMCP] Delegating to Claude: ${model}`);
  const args = ["-p", "--output-format", "text", "--model", model, "--", prompt];
  const result = await runCommand("claude", args, { cwd, timeoutMs });

  if (result.exitCode !== 0) {
    console.error(`[OptimizerMCP] Claude delegation failed (exit ${result.exitCode})`);
    return {
      success: false,
      output: "",
      error: `Claude exited with code ${result.exitCode}: ${result.stderr}`,
      model_used: model,
      service_used: "claude",
      estimated_tokens: 0,
    };
  }

  console.error(`[OptimizerMCP] Claude delegation succeeded (${result.stdout.length} chars)`);
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
  console.error(`[OptimizerMCP] Delegating to Codex: ${model}`);
  const args = ["exec", "--model", model, "--full-auto", "--", prompt];
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
  // OpenCode provider: use "zhipuai-coding-plan/<model>" (the Zhipu AI Coding Plan)
  // Strip any existing provider prefix before adding the correct one
  const bareModel = model.replace(/^(zai|zhipuai-coding-plan)\//, "");
  const qualifiedModel = `zhipuai-coding-plan/${bareModel}`;
  console.error(`[OptimizerMCP] Delegating to Z.AI via OpenCode: ${qualifiedModel}`);
  const args = ["run", "-m", qualifiedModel, "--", prompt];
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
  const args = ["-p", "--output-format", "text", "--model", model, "--", prompt];
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

// ═══════════════════════════════════════════════════════════════════════
// Parallel Delegation
// ═══════════════════════════════════════════════════════════════════════

export interface SubtaskInput {
  id: string;
  prompt: string;
  targetService?: ServiceType;
  targetModel?: string;
  timeoutMs?: number;
  dependsOn?: string[];
}

export interface SubtaskResult {
  id: string;
  success: boolean;
  output: string;
  error?: string;
  model_used: string;
  service_used: string;
  estimated_tokens: number;
  complexity: string;
  routing_reasoning: string;
  used_fallback: boolean;
  duration_ms: number;
}

export interface ParallelDelegateResult {
  overall_success: boolean;
  completed: number;
  failed: number;
  total: number;
  total_estimated_tokens: number;
  subtask_results: SubtaskResult[];
  auto_split_used: boolean;
}

type Strategy = "spread" | "cheapest" | "fastest";

const COMPLEXITY_ORDER: Record<string, number> = {
  trivial: 0, simple: 1, moderate: 2, complex: 3, architectural: 4,
};

/**
 * Auto-split a task into subtasks using local Ollama model.
 * Returns null if Ollama is unavailable or parsing fails.
 */
async function autoSplitTask(task: string): Promise<SubtaskInput[] | null> {
  const prompt =
    `You are a task decomposition assistant. Split this task into 2-6 independent subtasks ` +
    `that can run in parallel with NO dependencies between them. ` +
    `Return ONLY a JSON array of objects with "id" (kebab-case) and "prompt" (detailed instruction) fields. ` +
    `No markdown, no explanation, just the JSON array.\n\nTask: ${task}`;

  const result = await callOllama(prompt, { model: "qwen3:1.7b", timeoutMs: 60_000 });
  if (!result.success) return null;

  try {
    let jsonStr = result.output;
    // Strip qwen3-style <think>...</think> tags before parsing
    jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const parsed = JSON.parse(jsonStr) as Array<{ id: string; prompt: string }>;
    if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 10) return null;

    return parsed.map((p) => ({
      id: p.id ?? `subtask-${Math.random().toString(36).slice(2, 6)}`,
      prompt: p.prompt,
    }));
  } catch {
    return null;
  }
}

function buildLayers(subtasks: SubtaskInput[]): SubtaskInput[][] {
  const idSet = new Set(subtasks.map((s) => s.id));
  const remaining = new Map(subtasks.map((s) => [s.id, s]));
  const completed = new Set<string>();
  const layers: SubtaskInput[][] = [];

  for (let safety = 0; safety < subtasks.length + 1; safety++) {
    const layer: SubtaskInput[] = [];
    for (const [id, task] of remaining) {
      const deps = task.dependsOn ?? [];
      for (const dep of deps) {
        if (!idSet.has(dep)) throw new Error(`Subtask '${id}' depends on unknown ID '${dep}'`);
      }
      if (deps.every((d) => completed.has(d))) {
        layer.push(task);
      }
    }
    if (layer.length === 0 && remaining.size > 0) {
      throw new Error(`Dependency cycle detected among: ${[...remaining.keys()].join(", ")}`);
    }
    if (layer.length === 0) break;
    for (const task of layer) {
      remaining.delete(task.id);
      completed.add(task.id);
    }
    layers.push(layer);
  }
  return layers;
}

function applySpreadStrategy(
  assignments: Array<{
    subtask: SubtaskInput;
    service: ServiceType;
    model: string;
    fallbackService: ServiceType;
    fallbackModel: string;
    complexity: string;
    reasoning: string;
  }>
): void {
  if (assignments.length < 3) return;

  const counts = new Map<ServiceType, number>();
  for (const a of assignments) {
    counts.set(a.service, (counts.get(a.service) ?? 0) + 1);
  }

  const maxPerService = Math.ceil(assignments.length / 2);

  for (const [service, count] of counts) {
    if (count <= maxPerService) continue;

    const onService = assignments
      .filter((a) => a.service === service)
      .sort((a, b) => (COMPLEXITY_ORDER[a.complexity] ?? 0) - (COMPLEXITY_ORDER[b.complexity] ?? 0));

    const excess = count - maxPerService;
    for (let i = 0; i < excess && i < onService.length; i++) {
      const item = onService[i];
      item.service = item.fallbackService;
      item.model = item.fallbackModel;
      item.reasoning += " [Redistributed by spread strategy]";
    }
  }
}

export async function parallelDelegate(
  input: {
    task?: string;
    subtasks?: SubtaskInput[];
    autoSplit?: boolean;
    strategy?: Strategy;
    globalTimeoutMs?: number;
  }
): Promise<ParallelDelegateResult> {
  const { strategy = "spread", globalTimeoutMs = 300_000 } = input;
  let subtasks = input.subtasks;
  let autoSplitUsed = false;

  // Auto-split mode: use Ollama to decompose a single task
  if (input.task && input.autoSplit === true && (!subtasks || subtasks.length === 0)) {
    console.error(`[OptimizerMCP] Auto-splitting task via Ollama...`);
    const split = await autoSplitTask(input.task);
    if (split) {
      subtasks = split;
      autoSplitUsed = true;
      console.error(`[OptimizerMCP] Split into ${split.length} subtasks: ${split.map(s => s.id).join(", ")}`);
    } else {
      return {
        overall_success: false,
        completed: 0, failed: 1, total: 1,
        total_estimated_tokens: 0,
        subtask_results: [{
          id: "auto-split", success: false, output: "",
          error: "Auto-split failed. Ollama may not be installed or the task couldn't be decomposed. " +
            "Install Ollama (brew install ollama && ollama pull qwen3:1.7b) or provide pre-split subtasks.",
          model_used: "", service_used: "", estimated_tokens: 0,
          complexity: "unknown", routing_reasoning: "", used_fallback: false, duration_ms: 0,
        }],
        auto_split_used: false,
      };
    }
  }

  if (!subtasks || subtasks.length < 2) {
    return {
      overall_success: false,
      completed: 0, failed: 1, total: 0,
      total_estimated_tokens: 0,
      subtask_results: [{
        id: "validation", success: false, output: "",
        error: "parallel_delegate requires at least 2 subtasks. Provide subtasks array or a task with auto_split.",
        model_used: "", service_used: "", estimated_tokens: 0,
        complexity: "unknown", routing_reasoning: "", used_fallback: false, duration_ms: 0,
      }],
      auto_split_used: autoSplitUsed,
    };
  }

  // Classify and route each subtask
  const quotaStatuses = getQuotaStatus();
  const assignments = subtasks.map((subtask) => {
    if (subtask.targetService && subtask.targetModel) {
      return {
        subtask,
        service: subtask.targetService,
        model: subtask.targetModel,
        fallbackService: "zai" as ServiceType,
        fallbackModel: "glm-4.5-air",
        complexity: "unknown",
        reasoning: `Manual override: ${subtask.targetModel}@${subtask.targetService}`,
      };
    }

    const classification = classifyTask(subtask.prompt);
    const routing = routeTask(classification, quotaStatuses);

    return {
      subtask,
      service: (subtask.targetService ?? routing.recommended_service) as ServiceType,
      model: subtask.targetModel ?? routing.recommended_model,
      fallbackService: routing.fallback_service,
      fallbackModel: routing.fallback_model,
      complexity: classification.complexity,
      reasoning: routing.reasoning,
    };
  });

  // Apply distribution strategy
  if (strategy === "spread") {
    applySpreadStrategy(assignments);
  } else if (strategy === "cheapest") {
    for (const a of assignments) {
      if ((a.complexity === "trivial" || a.complexity === "simple") && a.service !== "zai") {
        a.service = "zai";
        a.model = a.complexity === "trivial" ? "glm-4.5-air" : "glm-4.7";
        a.reasoning += " [Cheapest strategy: routed to Z.AI]";
      }
    }
  }

  // Build execution DAG from dependsOn fields
  let layers: SubtaskInput[][];
  try {
    layers = buildLayers(subtasks);
  } catch (err) {
    return {
      overall_success: false,
      completed: 0, failed: 1, total: subtasks.length,
      total_estimated_tokens: 0,
      subtask_results: [{
        id: "dag-error", success: false, output: "",
        error: err instanceof Error ? err.message : String(err),
        model_used: "", service_used: "", estimated_tokens: 0,
        complexity: "unknown", routing_reasoning: "", used_fallback: false, duration_ms: 0,
      }],
      auto_split_used: autoSplitUsed,
    };
  }

  // Execute layers (parallel within each layer, sequential across layers)
  const assignmentMap = new Map(assignments.map((a) => [a.subtask.id, a]));
  const results = new Map<string, SubtaskResult>();
  const failedIds = new Set<string>();

  const executeAllLayers = async () => {
    for (const layer of layers) {
      const promises = layer.map(async (subtask): Promise<SubtaskResult> => {
        const deps = subtask.dependsOn ?? [];
        const failedDep = deps.find((d) => failedIds.has(d));
        if (failedDep) {
          return {
            id: subtask.id, success: false, output: "",
            error: `Skipped: dependency '${failedDep}' failed`,
            model_used: "", service_used: "", estimated_tokens: 0,
            complexity: "unknown", routing_reasoning: "",
            used_fallback: false, duration_ms: 0,
          };
        }

        const assignment = assignmentMap.get(subtask.id)!;
        const startTime = Date.now();
        console.error(`[OptimizerMCP] ▶ Subtask '${subtask.id}' → ${assignment.model}@${assignment.service}`);

        const delegationResult = await delegateTask(
          subtask.prompt,
          assignment.model,
          assignment.service,
          {
            timeoutMs: subtask.timeoutMs ?? 240_000,
            fallbackModel: assignment.fallbackModel,
            fallbackService: assignment.fallbackService,
          }
        );

        const durationMs = Date.now() - startTime;
        const status = delegationResult.success ? "✓" : "✗";
        console.error(`[OptimizerMCP] ${status} Subtask '${subtask.id}' completed in ${(durationMs / 1000).toFixed(1)}s (${delegationResult.model_used}@${delegationResult.service_used})`);

        return {
          id: subtask.id,
          success: delegationResult.success,
          output: delegationResult.output,
          error: delegationResult.error,
          model_used: delegationResult.model_used,
          service_used: delegationResult.service_used,
          estimated_tokens: delegationResult.estimated_tokens,
          complexity: assignment.complexity,
          routing_reasoning: assignment.reasoning,
          used_fallback: delegationResult.service_used !== assignment.service ||
            delegationResult.model_used !== assignment.model,
          duration_ms: durationMs,
        };
      });

      const settled = await Promise.allSettled(promises);
      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        const res = outcome.status === "fulfilled"
          ? outcome.value
          : {
              id: layer[i]?.id ?? `unknown-${i}`, success: false, output: "",
              error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
              model_used: "", service_used: "", estimated_tokens: 0,
              complexity: assignmentMap.get(layer[i]?.id ?? "")?.complexity ?? "unknown",
              routing_reasoning: "",
              used_fallback: false, duration_ms: 0,
            };
        results.set(res.id, res);
        if (!res.success) failedIds.add(res.id);
      }
    }
  };

  // Global timeout wrapper (clear timer to avoid leak when layers finish first)
  let globalTimer: ReturnType<typeof setTimeout>;
  await Promise.race([
    executeAllLayers(),
    new Promise<void>((_, reject) => {
      globalTimer = setTimeout(() => reject(new Error("Global timeout")), globalTimeoutMs);
    }),
  ]).catch((err) => {
    for (const subtask of subtasks!) {
      if (!results.has(subtask.id)) {
        results.set(subtask.id, {
          id: subtask.id, success: false, output: "",
          error: `Timed out: ${err instanceof Error ? err.message : String(err)}`,
          model_used: "", service_used: "", estimated_tokens: 0,
          complexity: assignmentMap.get(subtask.id)?.complexity ?? "unknown",
          routing_reasoning: "", used_fallback: false, duration_ms: 0,
        });
      }
    }
  });
  clearTimeout(globalTimer!);

  // Assemble results in original subtask order
  const orderedResults = subtasks.map((s) => results.get(s.id)!).filter(Boolean);
  const completedCount = orderedResults.filter((r) => r.success).length;

  return {
    overall_success: completedCount === orderedResults.length,
    completed: completedCount,
    failed: orderedResults.length - completedCount,
    total: orderedResults.length,
    total_estimated_tokens: orderedResults.reduce((sum, r) => sum + r.estimated_tokens, 0),
    subtask_results: orderedResults,
    auto_split_used: autoSplitUsed,
  };
}
