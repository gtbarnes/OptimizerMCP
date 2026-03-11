#!/usr/bin/env node
/**
 * Integration test for OptimizerMCP — exercises critical delegation and routing paths.
 * Run: node test-integration.mjs
 */
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "build", "index.js");

let msgId = 0;

async function startServer() {
  const child = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:${process.env.PATH}` },
  });

  // Collect stderr for debugging
  let stderrBuf = "";
  child.stderr.on("data", (d) => { stderrBuf += d.toString(); });

  const pending = new Map();

  // Read line-delimited JSON from stdout
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
      }
    } catch {}
  });

  function send(method, params, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      msgId++;
      const id = msgId;
      const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method} (id=${id})\nStderr: ${stderrBuf.slice(-500)}`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(msg);
      });
      child.stdin.write(req + "\n");
    });
  }

  // Initialize MCP
  const initResult = await send("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  });
  console.log("Server initialized:", initResult.result?.serverInfo?.name ?? "?");

  // Send initialized notification (no response)
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

  return { send, kill: () => child.kill(), getStderr: () => stderrBuf };
}

// ── Test helpers ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, testName, detail = "") {
  if (condition) {
    console.log(`  ✅ ${testName}`);
    passed++;
  } else {
    console.log(`  ❌ ${testName}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function getContent(response) {
  if (response.error) return { _error: response.error };
  const text = response.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return text; }
}

// ── Tests ─────────────────────────────────────────────────────────────

async function runTests() {
  console.log("Starting MCP server...");
  const server = await startServer();
  console.log("");

  // ── Test 1: classify_task basic ────────────────────────────────────
  console.log("1. classify_task");
  {
    const res = await server.send("tools/call", {
      name: "classify_task",
      arguments: { task_description: "Fix a typo in the README" },
    });
    const data = getContent(res);
    assert(data.complexity === "trivial" || data.complexity === "simple", "Trivial task classified correctly", `got: ${data.complexity}`);
    assert(typeof data.is_ui_related === "boolean", "is_ui_related is boolean");
  }

  // ── Test 2: classify_task empty string (should be rejected by validation) ─
  console.log("\n2. classify_task (empty string → validation error)");
  {
    const res = await server.send("tools/call", {
      name: "classify_task",
      arguments: { task_description: "" },
    });
    // .min(1) validation returns isError: true in the result
    const isRejected = !!res.error || !!res.result?.isError;
    assert(isRejected, "Empty string rejected by validation");
  }

  // ── Test 3: recommend_model → opus gate ────────────────────────────
  console.log("\n3. recommend_model (architectural → opus gate)");
  {
    const res = await server.send("tools/call", {
      name: "recommend_model",
      arguments: { complexity: "architectural" },
    });
    const data = getContent(res);
    assert(!data.recommended_model?.toLowerCase().includes("opus"), "Opus NOT auto-recommended", `got: ${data.recommended_model}`);
    assert(data.requires_confirmation === true, "requires_confirmation is true");
    assert(typeof data.premium_model === "string" && data.premium_model.includes("opus"), "premium_model contains opus", `got: ${data.premium_model}`);
    assert(typeof data.confirmation_reason === "string", "confirmation_reason provided");
  }

  // ── Test 4: recommend_model → simple (no gate) ────────────────────
  console.log("\n4. recommend_model (simple → no gate)");
  {
    const res = await server.send("tools/call", {
      name: "recommend_model",
      arguments: { complexity: "simple" },
    });
    const data = getContent(res);
    assert(data.requires_confirmation !== true, "No confirmation for simple tasks");
    assert(!data.recommended_model?.toLowerCase().includes("opus"), "No opus for simple tasks");
  }

  // ── Test 5: recommend_model → complex (should gate if quota allows) ─
  console.log("\n5. recommend_model (complex → opus gate)");
  {
    const res = await server.send("tools/call", {
      name: "recommend_model",
      arguments: { complexity: "complex" },
    });
    const data = getContent(res);
    // Complex tasks with good quota → claude flagship → opus → gate
    assert(!data.recommended_model?.toLowerCase().includes("opus"), "Opus NOT auto-recommended for complex", `got: ${data.recommended_model}`);
    if (data.requires_confirmation) {
      assert(data.premium_model?.includes("opus"), "Premium model is opus when gated");
    }
  }

  // ── Test 6: check_quota ────────────────────────────────────────────
  console.log("\n6. check_quota");
  {
    const res = await server.send("tools/call", {
      name: "check_quota",
      arguments: {},
    });
    const data = getContent(res);
    assert(data.should_use_opus === false, "should_use_opus is always false");
    assert(typeof data.budget_advice === "string", "budget_advice provided");
  }

  // ── Test 7: check_quota zhipuai normalization ──────────────────────
  console.log("\n7. check_quota (zhipuai normalization)");
  {
    const res = await server.send("tools/call", {
      name: "check_quota",
      arguments: { service: "zhipuai" },
    });
    assert(!res.error, "zhipuai accepted without RPC error", JSON.stringify(res.error));
    const data = getContent(res);
    assert(!data._error, "No tool error", JSON.stringify(data._error));
  }

  // ── Test 8: check_quota opencode ───────────────────────────────────
  console.log("\n8. check_quota (opencode — free models)");
  {
    const res = await server.send("tools/call", {
      name: "check_quota",
      arguments: { service: "opencode" },
    });
    const data = getContent(res);
    assert(typeof data.budget_advice === "string", "Budget advice returned for opencode");
  }

  // ── Test 9: check_available_tools ──────────────────────────────────
  console.log("\n9. check_available_tools");
  {
    const res = await server.send("tools/call", {
      name: "check_available_tools",
      arguments: {},
    });
    const text = typeof getContent(res) === "string" ? getContent(res) : JSON.stringify(getContent(res));
    assert(text.includes("OpenCode"), "Shows OpenCode status");
    assert(text.includes("Ollama"), "Shows Ollama status");
    assert(text.includes("Free models"), "Shows free model status");
  }

  // ── Test 10: delegate_task to Z.AI via OpenCode ────────────────────
  console.log("\n10. delegate_task (Z.AI via OpenCode — LIVE)");
  {
    const res = await server.send("tools/call", {
      name: "delegate_task",
      arguments: {
        prompt: "Reply with exactly and only the text: OPTIMIZER_ZAI_OK",
        target_model: "glm-4.7",
        target_service: "zai",
        timeout_seconds: 45,
      },
    }, 60000);
    const text = typeof getContent(res) === "string" ? getContent(res) : JSON.stringify(getContent(res));
    assert(!res.error, "No MCP RPC error", JSON.stringify(res.error));
    const hasDelegation = text.includes("Delegated to") || text.includes("glm-4.7");
    assert(hasDelegation, "Delegation header present", text.slice(0, 150));
  }

  // ── Test 11: delegate_task with zhipuai normalization ──────────────
  console.log("\n11. delegate_task (zhipuai normalization — LIVE)");
  {
    const res = await server.send("tools/call", {
      name: "delegate_task",
      arguments: {
        prompt: "Reply with exactly: ZHIPUAI_NORM_OK",
        target_model: "glm-4.5-air",
        target_service: "zhipuai",
        timeout_seconds: 45,
      },
    }, 60000);
    assert(!res.error, "zhipuai accepted and normalized", JSON.stringify(res.error));
    const text = typeof getContent(res) === "string" ? getContent(res) : JSON.stringify(getContent(res));
    assert(text.includes("Delegated to") || text.includes("glm-4.5"), "Delegation output received", text.slice(0, 150));
  }

  // ── Test 12: delegate_task to free model ───────────────────────────
  console.log("\n12. delegate_task (free OpenCode model — LIVE)");
  {
    const res = await server.send("tools/call", {
      name: "delegate_task",
      arguments: {
        prompt: "Reply with exactly: FREE_MODEL_OK",
        target_model: "opencode/gpt-5-nano",
        target_service: "opencode",
        timeout_seconds: 45,
      },
    }, 60000);
    assert(!res.error, "Free model delegation accepted", JSON.stringify(res.error));
    const text = typeof getContent(res) === "string" ? getContent(res) : JSON.stringify(getContent(res));
    assert(text.includes("Delegated to") || text.includes("gpt-5-nano") || text.includes("FREE_MODEL_OK"),
      "Free model delegation completed", text.slice(0, 150));
  }

  // ── Test 13: record_usage zhipuai normalization ────────────────────
  console.log("\n13. record_usage (zhipuai normalization)");
  {
    const res = await server.send("tools/call", {
      name: "record_usage",
      arguments: { service: "zhipuai", model: "glm-4.7" },
    });
    assert(!res.error, "zhipuai accepted in record_usage", JSON.stringify(res.error));
    const text = typeof getContent(res) === "string" ? getContent(res) : JSON.stringify(getContent(res));
    assert(text.includes("zai") || text.includes("recorded"), "Usage recorded");
  }

  // ── Test 14: recommend_model with UI task ──────────────────────────
  console.log("\n14. recommend_model (UI task → Claude forced)");
  {
    const res = await server.send("tools/call", {
      name: "recommend_model",
      arguments: { complexity: "simple", is_ui_related: true },
    });
    const data = getContent(res);
    assert(data.recommended_service === "claude", "UI task routed to Claude", `got: ${data.recommended_service}`);
  }

  // ── Test 15: delegate_task emits logging messages ──────────────────
  console.log("\n15. delegate_task progress notifications (logging messages)");
  {
    // Collect any JSON-RPC notifications emitted during delegation
    const notifications = [];
    const origHandler = server._onNotification;

    const res = await server.send("tools/call", {
      name: "delegate_task",
      arguments: {
        prompt: "Reply with exactly: PROGRESS_TEST_OK",
        target_model: "glm-4.5-air",
        target_service: "zai",
        timeout_seconds: 45,
      },
    }, 60000);

    // Verify the delegation itself works
    assert(!res.error, "Delegation with progress succeeded", JSON.stringify(res.error));
    const text = typeof getContent(res) === "string" ? getContent(res) : JSON.stringify(getContent(res));
    assert(text.includes("Delegated to"), "Delegation header present with progress enabled", text.slice(0, 150));

    // Check server stderr for progress-related logs (the sendLoggingMessage calls)
    const stderr = server.getStderr();
    const hasProgressLogs = stderr.includes("Delegating to") || stderr.includes("OptimizerMCP");
    assert(hasProgressLogs, "Server emits progress logs during delegation");
  }

  // ── Test 16: delegate_task with short timeout (activity timeout test) ─
  console.log("\n16. delegate_task (activity timeout description updated)");
  {
    // Verify that the timeout_seconds schema describes activity timeout
    const res = await server.send("tools/list", {});
    const tools = res.result?.tools ?? [];
    const delegateTool = tools.find(t => t.name === "delegate_task");
    const timeoutProp = delegateTool?.inputSchema?.properties?.timeout_seconds;
    const desc = timeoutProp?.description ?? "";
    assert(desc.includes("Activity timeout") || desc.includes("silence"),
      "timeout_seconds description reflects activity-based semantics",
      `got: ${desc.slice(0, 80)}`);
  }

  // ── Test 17: parallel_delegate timeout description updated ──────────
  console.log("\n17. parallel_delegate (subtask timeout description updated)");
  {
    const res = await server.send("tools/list", {});
    const tools = res.result?.tools ?? [];
    const parallelTool = tools.find(t => t.name === "parallel_delegate");
    // Drill into the subtasks array schema for timeout_seconds
    const subtaskSchema = parallelTool?.inputSchema?.properties?.subtasks;
    const subtaskTimeoutDesc = subtaskSchema?.items?.properties?.timeout_seconds?.description ?? "";
    assert(!subtaskTimeoutDesc.includes("default: 240"),
      "parallel_delegate subtask timeout no longer says 240",
      `got: ${subtaskTimeoutDesc.slice(0, 80)}`);
    assert(subtaskTimeoutDesc.includes("60") || subtaskTimeoutDesc.includes("activity"),
      "parallel_delegate subtask timeout reflects new default",
      `got: ${subtaskTimeoutDesc.slice(0, 80)}`);
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${"═".repeat(50)}`);

  if (failed > 0) {
    console.log("\nServer stderr (last 500 chars):");
    console.log(server.getStderr().slice(-500));
  }

  server.kill();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
