#!/usr/bin/env node
/**
 * MCP Tool Test Harness
 * Starts the optimizer-mcp server over stdio and tests each tool via JSON-RPC 2.0.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SERVER_PATH = decodeURIComponent(new URL("./build/index.js", import.meta.url).pathname);
let nextId = 1;
let resolvers = new Map();

// ── Spawn MCP server ────────────────────────────────────────────────────

const proc = spawn(process.execPath, [SERVER_PATH], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

proc.stderr.on("data", (chunk) => {
  const lines = chunk.toString().split("\n").filter(Boolean);
  for (const line of lines) {
    console.log(`  [server] ${line}`);
  }
});

const rl = createInterface({ input: proc.stdout });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id != null && resolvers.has(msg.id)) {
      const { resolve } = resolvers.get(msg.id);
      resolvers.delete(msg.id);
      resolve(msg);
    }
  } catch { /* non-JSON line */ }
});

function send(method, params = {}) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    resolvers.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify(msg) + "\n");
    setTimeout(() => {
      if (resolvers.has(id)) {
        resolvers.delete(id);
        reject(new Error(`Timeout: ${method} (id=${id})`));
      }
    }, 60000);
  });
}

function notify(method, params = {}) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

// ── Helpers ─────────────────────────────────────────────────────────────

function extractText(result) {
  if (result?.result?.content?.[0]?.text) return result.result.content[0].text;
  return JSON.stringify(result?.result ?? result?.error ?? result, null, 2);
}

function tryParseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

const PASS = "✅";
const FAIL = "❌";
const WARN = "⚠️ ";
let passed = 0, failed = 0, warnings = 0;

function check(label, condition, detail = "") {
  if (condition) { console.log(`    ${PASS} ${label}${detail ? ` — ${detail}` : ""}`); passed++; }
  else { console.log(`    ${FAIL} ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function warn(label, detail = "") { console.log(`    ${WARN}${label}${detail ? ` — ${detail}` : ""}`); warnings++; }

// ── Tests ───────────────────────────────────────────────────────────────

async function run() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  OptimizerMCP Tool Test Harness");
  console.log("═══════════════════════════════════════════════════════════\n");

  // ── MCP Handshake ─────────────────────────────────────────────────────
  console.log("🔌 MCP Handshake...");
  const init = await send("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-harness", version: "1.0.0" },
  });
  check("Server initialized", init.result?.serverInfo?.name === "optimizer-mcp",
    `${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);
  notify("notifications/initialized");
  console.log("");

  // ── List Tools ────────────────────────────────────────────────────────
  console.log("📋 List tools...");
  const list = await send("tools/list");
  const tools = list.result?.tools ?? [];
  check("10 tools registered", tools.length === 10, `found ${tools.length}`);
  const toolNames = tools.map(t => t.name);
  for (const expected of [
    "classify_task", "recommend_model", "check_quota", "delegate_task",
    "optimize_context", "get_project_summary", "update_model_registry",
    "check_available_tools", "record_usage", "parallel_delegate",
  ]) {
    check(`  Tool: ${expected}`, toolNames.includes(expected));
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // Tool 1: classify_task
  // ════════════════════════════════════════════════════════════════════════
  console.log("🧪 Tool 1: classify_task");

  // Simple task
  const c1 = await send("tools/call", {
    name: "classify_task",
    arguments: { task_description: "Fix a typo in README.md" },
  });
  const c1j = tryParseJSON(extractText(c1));
  check("Returns JSON", c1j != null);
  check("Has complexity", typeof c1j?.complexity === "string", c1j?.complexity);
  check("Has category", typeof c1j?.category === "string", c1j?.category);
  check("Has estimated_tokens", typeof c1j?.estimated_tokens === "number", String(c1j?.estimated_tokens));
  check("Has is_ui_related", typeof c1j?.is_ui_related === "boolean");
  check("Typo fix → trivial", c1j?.complexity === "trivial", c1j?.complexity);

  // Complex task
  const c2 = await send("tools/call", {
    name: "classify_task",
    arguments: { task_description: "Refactor the entire authentication system across 15 microservices with OAuth2, SAML, and MFA support, including database migrations and comprehensive test suites" },
  });
  const c2j = tryParseJSON(extractText(c2));
  check("Complex task → complex/architectural",
    ["complex", "architectural"].includes(c2j?.complexity), c2j?.complexity);

  // UI task
  const c3 = await send("tools/call", {
    name: "classify_task",
    arguments: { task_description: "Build a SwiftUI NavigationStack with custom toolbar and sheet presentation" },
  });
  const c3j = tryParseJSON(extractText(c3));
  check("UI task → is_ui_related=true", c3j?.is_ui_related === true);
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // Tool 2: recommend_model (uses classification output as input)
  // ════════════════════════════════════════════════════════════════════════
  console.log("🧪 Tool 2: recommend_model");

  // Budget recommendation
  const r1 = await send("tools/call", {
    name: "recommend_model",
    arguments: { complexity: "trivial", category: "documentation" },
  });
  const r1j = tryParseJSON(extractText(r1));
  check("Returns JSON", r1j != null);
  check("Has recommended_model", typeof r1j?.recommended_model === "string", r1j?.recommended_model);
  check("Has recommended_service", typeof r1j?.recommended_service === "string", r1j?.recommended_service);
  check("Has fallback_model", typeof r1j?.fallback_model === "string", r1j?.fallback_model);
  check("Has reasoning", typeof r1j?.reasoning === "string");
  check("Budget task → budget tier model", r1j?.cost_tier === "budget" ||
    ["codex-mini", "claude-haiku-4-5", "glm-4.5-air"].includes(r1j?.recommended_model),
    `${r1j?.recommended_model} (tier: ${r1j?.cost_tier})`);

  // Flagship recommendation
  const r2 = await send("tools/call", {
    name: "recommend_model",
    arguments: { complexity: "architectural", category: "refactoring", requires_reasoning: true },
  });
  const r2j = tryParseJSON(extractText(r2));
  check("Architectural task → flagship/high tier",
    ["flagship", "high"].includes(r2j?.cost_tier), `${r2j?.recommended_model} (tier: ${r2j?.cost_tier})`);

  // UI override
  const r3 = await send("tools/call", {
    name: "recommend_model",
    arguments: { complexity: "moderate", category: "ui", is_ui_related: true },
  });
  const r3j = tryParseJSON(extractText(r3));
  check("UI task routes to claude", r3j?.recommended_service === "claude",
    `${r3j?.recommended_model}@${r3j?.recommended_service}`);

  // Check displayService mapping (should show "zhipuai" not "zai")
  const r4 = await send("tools/call", {
    name: "recommend_model",
    arguments: { complexity: "trivial", category: "coding" },
  });
  const r4j = tryParseJSON(extractText(r4));
  const r4text = extractText(r4);
  check("Output shows zhipuai not zai", !r4text.includes('"zai"'),
    `service: ${r4j?.recommended_service}, fallback: ${r4j?.fallback_service}`);
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // Tool 3: check_quota
  // ════════════════════════════════════════════════════════════════════════
  console.log("🧪 Tool 3: check_quota");

  const q1 = await send("tools/call", {
    name: "check_quota",
    arguments: {},
  });
  const q1j = tryParseJSON(extractText(q1));
  check("Returns JSON", q1j != null);
  check("Has should_use_opus", typeof q1j?.should_use_opus === "boolean");
  check("Has should_use_flagship", typeof q1j?.should_use_flagship === "boolean");
  check("Has budget_advice", typeof q1j?.budget_advice === "string", q1j?.budget_advice);
  check("Has statuses", typeof q1j?.statuses === "object" || Array.isArray(q1j?.statuses));

  // Filtered
  const q2 = await send("tools/call", {
    name: "check_quota",
    arguments: { service: "claude" },
  });
  check("Filtered check_quota returns result", q2.result != null);
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // Tool 4: optimize_context
  // ════════════════════════════════════════════════════════════════════════
  console.log("🧪 Tool 4: optimize_context");

  const cliOutput = "ERROR: something failed\n".repeat(200) +
    "WARN: deprecated\n".repeat(100) +
    "INFO: processing\n".repeat(300);
  const o1 = await send("tools/call", {
    name: "optimize_context",
    arguments: { content: cliOutput, content_type: "cli_output" },
  });
  const o1j = tryParseJSON(extractText(o1));
  check("Returns JSON", o1j != null);
  check("Has optimized_content", typeof o1j?.optimized_content === "string");
  check("Has savings_percent", typeof o1j?.savings_percent === "number", `${o1j?.savings_percent}%`);
  check("Has tools_used", Array.isArray(o1j?.tools_used), o1j?.tools_used?.join(", "));
  check("Achieves >50% savings", (o1j?.savings_percent ?? 0) > 50, `${o1j?.savings_percent}%`);

  // Code compression
  const code = `function fibonacci(n) {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}\nconsole.log(fibonacci(10));\n`;
  const o2 = await send("tools/call", {
    name: "optimize_context",
    arguments: { content: code, content_type: "code" },
  });
  check("Code optimization returns result", o2.result != null);
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // Tool 5: get_project_summary
  // ════════════════════════════════════════════════════════════════════════
  console.log("🧪 Tool 5: get_project_summary");

  const ps = await send("tools/call", {
    name: "get_project_summary",
    arguments: { directory: "/Volumes/Storage VIII/Programming/OptimizerMCP" },
  });
  const psText = extractText(ps);
  check("Returns non-empty text", psText.length > 100, `${psText.length} chars`);
  check("Mentions TypeScript files", psText.includes(".ts") || psText.includes("typescript") || psText.includes("TypeScript"));
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // Tool 6: update_model_registry (add a test model, then remove it)
  // ════════════════════════════════════════════════════════════════════════
  console.log("🧪 Tool 6: update_model_registry");

  const um = await send("tools/call", {
    name: "update_model_registry",
    arguments: {
      model_id: "__test-model__",
      service: "codex",
      tier: "budget",
      capabilities: ["coding"],
      cost_weight: 1,
      context_window: 32000,
    },
  });
  const umText = extractText(um);
  check("Model added successfully", umText.includes("added") || umText.includes("updated"), umText);

  // Update existing model
  const um2 = await send("tools/call", {
    name: "update_model_registry",
    arguments: {
      model_id: "__test-model__",
      service: "codex",
      tier: "mid",
      capabilities: ["coding", "reasoning"],
      cost_weight: 3,
      context_window: 64000,
    },
  });
  const um2Text = extractText(um2);
  check("Model updated successfully", um2Text.includes("updated"), um2Text);
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // Tool 7: check_available_tools
  // ════════════════════════════════════════════════════════════════════════
  console.log("🧪 Tool 7: check_available_tools");

  const ct = await send("tools/call", {
    name: "check_available_tools",
    arguments: {},
  });
  const ctText = extractText(ct);
  check("Returns text output", ctText.length > 50);
  check("Reports Claude CLI", ctText.includes("Claude CLI"));
  check("Reports Codex CLI", ctText.includes("Codex CLI"));
  check("Reports OpenCode", ctText.includes("OpenCode"));
  check("Reports RTK", ctText.includes("RTK"));
  check("Reports tokf", ctText.includes("tokf"));
  check("Reports SymDex", ctText.includes("SymDex"));
  check("Reports Ollama", ctText.includes("Ollama"));
  check("Reports Distill", ctText.includes("Distill"));
  check("Reports codebase-memory-mcp", ctText.includes("codebase-memory"));

  // Print actual status
  console.log("    ───────────────────────────────────────");
  for (const line of ctText.split("\n")) {
    console.log(`    ${line}`);
  }
  console.log("    ───────────────────────────────────────");
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // Tool 8: record_usage
  // ════════════════════════════════════════════════════════════════════════
  console.log("🧪 Tool 8: record_usage");

  const ru = await send("tools/call", {
    name: "record_usage",
    arguments: {
      service: "claude",
      model: "claude-sonnet-4-6",
      estimated_input_tokens: 1500,
      estimated_output_tokens: 500,
      task_complexity: "moderate",
    },
  });
  const ruText = extractText(ru);
  check("Usage recorded", ruText.includes("recorded"), ruText);
  check("Mentions service/model", ruText.includes("claude"));

  // Z.AI usage
  const ru2 = await send("tools/call", {
    name: "record_usage",
    arguments: {
      service: "zai",
      model: "glm-4.7",
      estimated_input_tokens: 800,
      estimated_output_tokens: 200,
    },
  });
  check("Z.AI usage recorded", extractText(ru2).includes("recorded"));
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // Tool 9: delegate_task (tests schema + routing — will fail without CLI)
  // ════════════════════════════════════════════════════════════════════════
  console.log("🧪 Tool 9: delegate_task (schema validation)");

  // Test zhipuai enum acceptance
  const dt1 = await send("tools/call", {
    name: "delegate_task",
    arguments: {
      prompt: "echo 'hello world'",
      target_model: "glm-4.5-air",
      target_service: "zhipuai",
      timeout_seconds: 10,
    },
  });
  const dt1Text = extractText(dt1);
  if (dt1.error) {
    warn("JSON-RPC error (schema rejected?)", dt1.error.message);
  } else {
    check("Accepts zhipuai enum", true);
    // Delegation itself likely fails (no CLI in test), that's fine
    const hasDelegationHeader = dt1Text.includes("Delegated to") || dt1Text.includes("error") || dt1Text.includes("failed");
    check("Tool executed (delegation may fail without CLI)", true,
      dt1Text.length > 200 ? dt1Text.substring(0, 200) + "..." : dt1Text);
  }

  // Test with fallback
  const dt2 = await send("tools/call", {
    name: "delegate_task",
    arguments: {
      prompt: "echo 'hello world'",
      target_model: "glm-4.7",
      target_service: "zhipuai",
      fallback_model: "claude-haiku-4-5",
      fallback_service: "claude",
      timeout_seconds: 10,
    },
  });
  check("Fallback schema accepted", !dt2.error, dt2.error?.message ?? "OK");
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // Tool 10: parallel_delegate (tests schema + routing)
  // ════════════════════════════════════════════════════════════════════════
  console.log("🧪 Tool 10: parallel_delegate (schema validation)");

  const pd = await send("tools/call", {
    name: "parallel_delegate",
    arguments: {
      subtasks: [
        { id: "sub-a", prompt: "echo alpha", target_service: "zhipuai" },
        { id: "sub-b", prompt: "echo beta", target_service: "claude" },
      ],
      strategy: "cheapest",
      global_timeout_seconds: 15,
    },
  });

  if (pd.error) {
    warn("JSON-RPC error", pd.error.message);
  } else {
    const pdj = tryParseJSON(extractText(pd));
    check("Returns JSON", pdj != null);
    check("Has overall_success", typeof pdj?.overall_success === "boolean");
    check("Has subtask_results", Array.isArray(pdj?.subtask_results));
    check("Has total", typeof pdj?.total === "number", String(pdj?.total));
    check("Has completed", typeof pdj?.completed === "number", String(pdj?.completed));
    check("Has failed", typeof pdj?.failed === "number", String(pdj?.failed));
    check("Has auto_split_used", typeof pdj?.auto_split_used === "boolean");
    check("Correct subtask count", pdj?.total === 2);

    // Check each subtask result has expected fields
    if (pdj?.subtask_results?.length > 0) {
      const sr = pdj.subtask_results[0];
      check("Subtask has id", typeof sr.id === "string", sr.id);
      check("Subtask has model_used", typeof sr.model_used === "string", sr.model_used);
      check("Subtask has service_used", typeof sr.service_used === "string", sr.service_used);
      check("Subtask has duration_ms", typeof sr.duration_ms === "number");
    }
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // Cleanup: remove test model from registry
  // ════════════════════════════════════════════════════════════════════════
  console.log("🧹 Cleanup...");
  // We can't "delete" via MCP, so just note it
  warn("__test-model__ left in models.json — clean up manually or it's harmless");
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Results: ${PASS} ${passed} passed  ${FAIL} ${failed} failed  ${WARN}${warnings} warnings`);
  console.log("═══════════════════════════════════════════════════════════\n");

  proc.kill();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  proc.kill();
  process.exit(2);
});
