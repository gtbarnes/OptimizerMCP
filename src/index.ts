#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { classifyTask } from "./tools/classify.js";
import { routeTask } from "./tools/route.js";
import { checkQuota } from "./tools/quota.js";
import { delegateTask, parallelDelegate } from "./tools/delegate.js";
import { optimizeContext, getProjectSummary } from "./tools/optimize.js";
import { getQuotaStatus, recordUsage } from "./tracking/usage-store.js";
import { invalidateRegistryCache } from "./config/models.js";
import { detectAvailableTools } from "./utils/subprocess.js";

// Display-friendly service names for user-facing output
function displayService(service: string): string {
  return service === "zai" ? "zhipuai" : service;
}

const server = new McpServer({
  name: "optimizer-mcp",
  version: "1.0.0",
});

// ── Tool 1: classify_task ──────────────────────────────────────────────

server.registerTool(
  "classify_task",
  {
    description:
      "Classify a task by complexity to determine the optimal model and approach. " +
      "Call this FIRST before starting any work. Returns complexity level, " +
      "estimated token usage, and task category.",
    inputSchema: {
      task_description: z
        .string()
        .describe("The user's task description or prompt to classify"),
    },
  },
  async ({ task_description }) => {
    const classification = classifyTask(task_description);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              complexity: classification.complexity,
              estimated_tokens: classification.estimated_tokens,
              category: classification.category,
              requires_multi_file: classification.requires_multi_file,
              requires_reasoning: classification.requires_reasoning,
              is_agentic: classification.is_agentic,
              is_ui_related: classification.is_ui_related,
              confidence: classification.confidence,
              signals: classification.signals,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool 2: recommend_model ────────────────────────────────────────────

server.registerTool(
  "recommend_model",
  {
    description:
      "Get a model recommendation based on task complexity and current quota usage. " +
      "Call after classify_task to determine which model and service to use.",
    inputSchema: {
      complexity: z
        .enum(["trivial", "simple", "moderate", "complex", "architectural"])
        .describe("Task complexity from classify_task"),
      category: z
        .string()
        .optional()
        .describe("Task category from classify_task"),
      requires_multi_file: z
        .boolean()
        .optional()
        .describe("Whether the task requires multi-file understanding"),
      requires_reasoning: z
        .boolean()
        .optional()
        .describe("Whether the task requires deep reasoning"),
      is_agentic: z
        .boolean()
        .optional()
        .describe("Whether the task involves agentic workflows"),
      is_ui_related: z
        .boolean()
        .optional()
        .describe("Whether the task involves UI/visual work (forces Claude for computer-use)"),
      composite_score: z
        .number()
        .optional()
        .describe("Composite signal score from classify_task (0-1)"),
    },
  },
  async ({ complexity, category, requires_multi_file, requires_reasoning, is_agentic, is_ui_related, composite_score }) => {
    const classification = {
      complexity,
      estimated_tokens: 0,
      category: category ?? "general",
      requires_multi_file: requires_multi_file ?? false,
      requires_reasoning: requires_reasoning ?? false,
      is_agentic: is_agentic ?? false,
      is_ui_related: is_ui_related ?? false,
      confidence: 1.0,
      signals: {
        keyword_score: 0, structural_score: 0, intent_score: 0,
        scope_score: 0, reasoning_score: 0, agentic_score: 0,
        composite: composite_score ?? 0,
      },
    };

    const quotaStatuses = getQuotaStatus();
    const decision = routeTask(classification, quotaStatuses);

    // Replace internal "zai" with "zhipuai" for user-facing output
    const displayDecision = {
      ...decision,
      recommended_service: displayService(decision.recommended_service),
      fallback_service: displayService(decision.fallback_service),
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(displayDecision, null, 2),
        },
      ],
    };
  }
);

// ── Tool 3: check_quota ────────────────────────────────────────────────

server.registerTool(
  "check_quota",
  {
    description:
      "Check current usage quota across services. Returns remaining capacity, " +
      "budget advice, and whether expensive models should be used. " +
      "Call this to make informed decisions about model selection.",
    inputSchema: {
      service: z
        .enum(["codex", "claude", "zai"])
        .optional()
        .describe("Filter to a specific service, or omit for all"),
    },
  },
  async ({ service }) => {
    const report = checkQuota(service);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              should_use_opus: report.should_use_opus,
              should_use_flagship: report.should_use_flagship,
              budget_advice: report.budget_advice,
              statuses: report.statuses,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool 4: delegate_task ──────────────────────────────────────────────

server.registerTool(
  "delegate_task",
  {
    description:
      "Delegate a task to a specific model on a specific service. " +
      "Executes via subprocess (claude CLI, codex exec, or OpenCode/Z.AI API) and returns the result. " +
      "Use when recommend_model suggests a different service than the current one. " +
      "Pass fallback_model and fallback_service from recommend_model for automatic retry on failure.",
    inputSchema: {
      prompt: z.string().describe("The task prompt to delegate"),
      target_model: z
        .string()
        .describe("Model ID to use (e.g., claude-sonnet-4-6, codex-mini, glm-4.7)"),
      target_service: z
        .enum(["codex", "claude", "zai", "zhipuai"])
        .describe("Which service to delegate to (zhipuai = Z.AI Coding Plan)"),
      fallback_model: z
        .string()
        .optional()
        .describe("Fallback model ID if primary fails (from recommend_model)"),
      fallback_service: z
        .enum(["codex", "claude", "zai", "zhipuai"])
        .optional()
        .describe("Fallback service if primary fails (from recommend_model)"),
      timeout_seconds: z
        .number()
        .optional()
        .describe("Timeout in seconds (default: 240)"),
    },
  },
  async ({ prompt, target_model, target_service, fallback_model, fallback_service, timeout_seconds }) => {
    // Normalize "zhipuai" to internal "zai" service type
    const normalizedService = (target_service === "zhipuai" ? "zai" : target_service) as "codex" | "claude" | "zai";
    const normalizedFallback = (fallback_service === "zhipuai" ? "zai" : fallback_service) as "codex" | "claude" | "zai" | undefined;
    const result = await delegateTask(prompt, target_model, normalizedService, {
      timeoutMs: (timeout_seconds ?? 240) * 1000,
      fallbackModel: fallback_model,
      fallbackService: normalizedFallback,
    });

    const header = `[Delegated to ${result.model_used}@${displayService(result.service_used)} | ~${result.estimated_tokens} tokens]`;
    return {
      content: [
        {
          type: "text" as const,
          text: result.success
            ? `${header}\n\n${result.output}`
            : `${header}\nERROR: ${result.error}\n\nPartial output:\n${result.output}`,
        },
      ],
    };
  }
);

// ── Tool 5: optimize_context ───────────────────────────────────────────

server.registerTool(
  "optimize_context",
  {
    description:
      "Optimize and compress content before sending to a model. " +
      "Reduces token usage by removing noise, deduplicating, and using code indexing tools. " +
      "Pass file paths for code content, or raw text for CLI output compression.",
    inputSchema: {
      content: z.string().describe("The content to optimize"),
      file_paths: z
        .array(z.string())
        .optional()
        .describe("File paths to get optimized summaries of instead of full content"),
      content_type: z
        .enum(["cli_output", "code", "logs", "text", "auto"])
        .optional()
        .describe("Hint about content type for better compression (default: auto-detect)"),
    },
  },
  async ({ content, file_paths, content_type }) => {
    const result = await optimizeContext(content, { filePaths: file_paths, contentType: content_type });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              optimized_content: result.optimized_content,
              original_tokens: result.original_token_estimate,
              optimized_tokens: result.optimized_token_estimate,
              savings_percent: result.savings_percent,
              tools_used: result.tools_used,
              suggestions: result.suggestions,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool 6: get_project_summary ────────────────────────────────────────

server.registerTool(
  "get_project_summary",
  {
    description:
      "Get a compressed project overview for the current working directory. " +
      "Uses code indexing tools if available for minimal token usage. " +
      "Call this instead of reading many files to understand project structure.",
    inputSchema: {
      directory: z
        .string()
        .optional()
        .describe("Directory to summarize (defaults to current working directory)"),
    },
  },
  async ({ directory }) => {
    const summary = await getProjectSummary(directory ?? process.cwd());

    return {
      content: [
        {
          type: "text" as const,
          text: summary,
        },
      ],
    };
  }
);

// ── Tool 7: update_model_registry ──────────────────────────────────────

server.registerTool(
  "update_model_registry",
  {
    description:
      "Add or update a model in the registry. Use when new models are released. " +
      "Changes are persisted to config/models.json.",
    inputSchema: {
      model_id: z.string().describe("Model identifier (e.g., gpt-6, claude-5)"),
      service: z.enum(["codex", "claude", "zai"]).describe("Which service provides this model"),
      tier: z
        .enum(["flagship", "high", "mid", "budget"])
        .describe("Cost/capability tier"),
      capabilities: z
        .array(z.string())
        .describe("List of capabilities (coding, reasoning, multi-file, etc.)"),
      cost_weight: z
        .number()
        .min(0)
        .max(20)
        .describe("Relative cost weight (0=free tier, 10=most expensive)"),
      context_window: z
        .number()
        .describe("Context window size in tokens"),
    },
  },
  async ({ model_id, service, tier, capabilities, cost_weight, context_window }) => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const configPath = join(__dirname, "..", "config", "models.json");
    const registry = JSON.parse(readFileSync(configPath, "utf-8"));

    const existing = registry.models.findIndex(
      (m: { id: string }) => m.id === model_id
    );
    const newModel = {
      id: model_id,
      service,
      tier,
      capabilities,
      cost_weight,
      context_window,
    };

    if (existing >= 0) {
      registry.models[existing] = newModel;
    } else {
      registry.models.push(newModel);
    }

    writeFileSync(configPath, JSON.stringify(registry, null, 2) + "\n");

    // Invalidate the in-memory cache so subsequent reads pick up the change
    invalidateRegistryCache();

    return {
      content: [
        {
          type: "text" as const,
          text: `Model ${model_id} ${existing >= 0 ? "updated" : "added"} successfully. ` +
            `Service: ${service}, Tier: ${tier}, Cost weight: ${cost_weight}`,
        },
      ],
    };
  }
);

// ── Tool 8: check_available_tools ──────────────────────────────────────

server.registerTool(
  "check_available_tools",
  {
    description:
      "Check which optimization tools are installed and available on this system. " +
      "Returns status of claude CLI, codex CLI, OpenCode, RTK, tokf, SymDex, and codebase-memory-mcp.",
    inputSchema: {},
  },
  async () => {
    const tools = await detectAvailableTools();

    const lines: string[] = ["Available Tools:"];
    lines.push(`  Claude CLI: ${tools.claude ? "YES" : "NO"}`);
    lines.push(`  Codex CLI: ${tools.codex ? "YES" : "NO"}`);
    lines.push(`  OpenCode (Z.AI): ${tools.opencode ? "YES" : "NO"}`);
    lines.push(`  RTK (token compressor): ${tools.rtk ? "YES" : "NO"}`);
    lines.push(`  tokf (output filter): ${tools.tokf ? "YES" : "NO"}`);
    lines.push(`  SymDex (code indexer): ${tools.symdex ? "YES" : "NO"}`);
    lines.push(`  codebase-memory-mcp: ${tools.codebaseMemory ? "YES" : "NO"}`);
    lines.push(`  Ollama (local LLM): ${tools.ollama ? "YES" : "NO"}`);
    lines.push(`  Distill (semantic compressor): ${tools.distill ? "YES" : "NO"}`);

    if (!tools.opencode) {
      lines.push("\nRECOMMENDED: Install OpenCode for Z.AI delegation (brew install anomalyco/tap/opencode)");
    }
    if (!tools.rtk && !tools.tokf) {
      lines.push("RECOMMENDED: Install RTK (cargo install rtk) or tokf (brew install mpecan/tokf/tokf)");
    }
    if (!tools.symdex && !tools.codebaseMemory) {
      lines.push("RECOMMENDED: Install SymDex (pip install symdex) or codebase-memory-mcp (https://github.com/DeusData/codebase-memory-mcp)");
    }
    if (!tools.ollama) {
      lines.push("RECOMMENDED: Install Ollama (brew install ollama && ollama pull qwen3:1.7b) for auto task splitting and semantic compression");
    }
    if (!tools.distill) {
      lines.push("RECOMMENDED: Install Distill (npm i -g @samuelfaj/distill) for 95-99% token savings on CLI output");
    }

    return {
      content: [
        {
          type: "text" as const,
          text: lines.join("\n"),
        },
      ],
    };
  }
);

// ── Tool 9: record_usage (manual) ──────────────────────────────────────

server.registerTool(
  "record_usage",
  {
    description:
      "Manually record a usage event for tracking purposes. " +
      "Use after completing a task to keep quota estimates accurate.",
    inputSchema: {
      service: z.enum(["codex", "claude", "zai"]).describe("Which service was used"),
      model: z.string().describe("Model ID that was used"),
      estimated_input_tokens: z
        .number()
        .optional()
        .describe("Estimated input tokens (default: 1000)"),
      estimated_output_tokens: z
        .number()
        .optional()
        .describe("Estimated output tokens (default: 500)"),
      task_complexity: z
        .string()
        .optional()
        .describe("Task complexity level"),
    },
  },
  async ({ service, model, estimated_input_tokens, estimated_output_tokens, task_complexity }) => {
    recordUsage({
      service,
      model,
      estimated_input_tokens: estimated_input_tokens ?? 1000,
      estimated_output_tokens: estimated_output_tokens ?? 500,
      task_complexity: task_complexity ?? "unknown",
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Usage recorded: ${service}/${model}`,
        },
      ],
    };
  }
);

// ── Tool 10: parallel_delegate ────────────────────────────────────────

server.registerTool(
  "parallel_delegate",
  {
    description:
      "Delegate multiple subtasks to different services in parallel. " +
      "Each subtask is independently classified, routed to the optimal service, and executed. " +
      "Use when a task can be decomposed into 2-10 independent pieces. " +
      "Supports auto-split via local Ollama model (set auto_split=true with a single task prompt). " +
      "The optimizer auto-routes each subtask — avoid specifying target_service unless required.",
    inputSchema: {
      task: z
        .string()
        .optional()
        .describe("Single task prompt for auto-split mode (requires Ollama). Ignored if subtasks provided."),
      subtasks: z
        .array(
          z.object({
            id: z.string().describe("Unique subtask identifier (e.g., 'auth-backend')"),
            prompt: z.string().describe("The task prompt to execute"),
            target_service: z
              .enum(["codex", "claude", "zai", "zhipuai"])
              .optional()
              .describe("Override auto-routing for this subtask (use 'zhipuai' for Z.AI)"),
            target_model: z
              .string()
              .optional()
              .describe("Override auto-routing with a specific model"),
            timeout_seconds: z
              .number()
              .optional()
              .describe("Per-subtask timeout (default: 240)"),
            depends_on: z
              .array(z.string())
              .optional()
              .describe("IDs of subtasks that must complete before this one starts"),
          })
        )
        .optional()
        .describe("2-10 subtasks to run in parallel. Required unless using auto_split with task."),
      auto_split: z
        .boolean()
        .optional()
        .describe("Use local Ollama model to auto-decompose the task (default: false)"),
      strategy: z
        .enum(["spread", "cheapest", "fastest"])
        .optional()
        .describe("Distribution strategy: spread (balance across services), cheapest (minimize cost), fastest (no rebalancing)"),
      global_timeout_seconds: z
        .number()
        .optional()
        .describe("Overall timeout for all subtasks in seconds (default: 300)"),
    },
  },
  async ({ task, subtasks, auto_split, strategy, global_timeout_seconds }) => {
    const result = await parallelDelegate({
      task,
      subtasks: subtasks?.map((s) => ({
        id: s.id,
        prompt: s.prompt,
        targetService: s.target_service === "zhipuai" ? "zai" : s.target_service,
        targetModel: s.target_model,
        timeoutMs: s.timeout_seconds ? s.timeout_seconds * 1000 : undefined,
        dependsOn: s.depends_on,
      })),
      autoSplit: auto_split,
      strategy: strategy ?? "spread",
      globalTimeoutMs: (global_timeout_seconds ?? 300) * 1000,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// ── Start server ───────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OptimizerMCP server running on stdio");
  console.error("Tools: classify_task, recommend_model, check_quota, delegate_task, parallel_delegate, optimize_context, get_project_summary, update_model_registry, check_available_tools, record_usage");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
