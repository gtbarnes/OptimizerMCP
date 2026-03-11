# Free OpenCode Model Fallback — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When 2+ paid services hit critical quota, auto-discover and route to free models from OpenCode's marketplace.

**Architecture:** New `"opencode"` ServiceType with runtime discovery via `opencode models opencode` CLI (5-min TTL cache), name-based heuristic ranking, escape hatch in router, and new delegation path. Original routing result becomes fallback on free model failure.

**Tech Stack:** TypeScript (ESM, Node16), MCP SDK, better-sqlite3, zod

**Spec:** `docs/superpowers/specs/2026-03-10-free-opencode-model-fallback-design.md`

**Verification:** `npm run build` (TypeScript strict compile). No test framework; smoke test via MCP server startup.

---

## File Structure

| File | Role | Action |
|------|------|--------|
| `src/config/models.ts` | ServiceType definition | Modify: add `"opencode"` to union |
| `src/tools/free-models.ts` | Discovery, caching, ranking | **Create** (~80 lines) |
| `src/tools/route.ts` | Routing matrix + escape hatch | Modify: add free model override after normal routing |
| `src/tools/delegate.ts` | Service delegation | Modify: add `"opencode"` case + `delegateToOpenCode()` |
| `src/tools/quota.ts` | Budget advice | Modify: add free model awareness |
| `src/index.ts` | MCP tool registration | Modify: schema enums, displayService, tool status |
| `AGENTS.md` | System prompt for Codex | Modify: add free model documentation |

---

## Chunk 1: Foundation + Discovery Layer

### Task 1: Expand ServiceType

**Files:**
- Modify: `src/config/models.ts:7`

- [ ] **Step 1: Add "opencode" to ServiceType**

In `src/config/models.ts`, change line 7 from:
```typescript
export type ServiceType = "codex" | "claude" | "zai";
```
to:
```typescript
export type ServiceType = "codex" | "claude" | "zai" | "opencode";
```

- [ ] **Step 2: Build to check for type errors**

Run: `cd "/Volumes/Storage VIII/Programming/OptimizerMCP" && npm run build`

Expected: Type errors in `dispatchToService()` switch (delegate.ts) — the `default` case already handles unknown services, so this should compile clean. If there are exhaustiveness errors anywhere, note them for later tasks.

- [ ] **Step 3: Commit**

```bash
git add src/config/models.ts
git commit -m "feat: add 'opencode' to ServiceType union"
```

---

### Task 2: Create free-models.ts — Types and Ranking

**Files:**
- Create: `src/tools/free-models.ts`

- [ ] **Step 1: Create the file with types, ranking heuristic, and cache structure**

Create `src/tools/free-models.ts`:

```typescript
// Subprocess imports used in Task 3 (discovery functions)
import { commandExists, runCommand } from "../utils/subprocess.js";

export interface DiscoveredFreeModel {
  provider: string;
  model: string;
  qualifiedName: string;
  rank: number;
}

// ── TTL cache ────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _cachedModels: DiscoveredFreeModel[] | null = null;
let _cacheTimestamp = 0;

/** Invalidate the free model cache (e.g. when tools change). */
export function invalidateFreeModelCache(): void {
  _cachedModels = null;
  _cacheTimestamp = 0;
}

// ── Name-based heuristic ranking ─────────────────────────────────────

const BUDGET_PENALTIES = /nano|mini|flash|tiny|small|lite/i;
const FREE_SUFFIX = /-free$/i;
const RECOGNIZED_PREFIXES = /^(gpt|glm|mimo|minimax|claude|llama|qwen|gemma|deepseek)/i;
const VERSION_PATTERN = /(\d+(?:\.\d+)?)/;

function rankModel(name: string): number {
  let score = 50; // base score

  // Version number bonus: higher versions = likely more capable
  const versionMatch = name.match(VERSION_PATTERN);
  if (versionMatch) {
    const version = parseFloat(versionMatch[1]);
    score += Math.min(version * 5, 30); // cap at +30
  }

  // Budget indicator penalties
  if (BUDGET_PENALTIES.test(name)) score -= 15;

  // Free suffix: slight penalty (usually stripped-down versions)
  if (FREE_SUFFIX.test(name)) score -= 5;

  // Recognized prefix: slight bonus (known model families)
  if (RECOGNIZED_PREFIXES.test(name)) score += 10;

  return score;
}
```

- [ ] **Step 2: Build to verify types compile**

Run: `npm run build`
Expected: Clean compile (file is importable but not yet imported anywhere).

- [ ] **Step 3: Commit**

```bash
git add src/tools/free-models.ts
git commit -m "feat: add free-models.ts with types and ranking heuristic"
```

---

### Task 3: Add discovery and getBestFreeModel

**Files:**
- Modify: `src/tools/free-models.ts`

- [ ] **Step 1: Add discoverFreeModels() and getBestFreeModel()**

Append to `src/tools/free-models.ts` after the `rankModel` function:

```typescript
// ── Discovery ────────────────────────────────────────────────────────

/**
 * Parse the tabular output of `opencode models opencode`.
 * Expected format:
 *   Model                Provider    Context  Output
 *   big-pickle           opencode    128000   16384
 *
 * Skips header lines. Extracts model name (col 0) and provider (col 1).
 */
function parseModelsOutput(stdout: string): DiscoveredFreeModel[] {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const models: DiscoveredFreeModel[] = [];

  for (const line of lines) {
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;

    // Skip header: "Model" or lines that don't look like model entries
    if (cols[0].toLowerCase() === "model" || cols[1].toLowerCase() === "provider") continue;

    // Skip if context/output columns aren't numeric (another header variant)
    if (isNaN(Number(cols[2])) || isNaN(Number(cols[3]))) continue;

    const model = cols[0];
    const provider = cols[1];

    models.push({
      provider,
      model,
      qualifiedName: `${provider}/${model}`,
      rank: rankModel(model),
    });
  }

  // Sort best-first (highest rank)
  return models.sort((a, b) => b.rank - a.rank);
}

/**
 * Discover free models available in OpenCode's marketplace.
 * Checks `commandExists("opencode")` fresh each call (not cached).
 * Model list is cached for 5 minutes.
 */
export async function discoverFreeModels(): Promise<DiscoveredFreeModel[]> {
  // Return cached result if fresh
  if (_cachedModels && Date.now() - _cacheTimestamp < CACHE_TTL_MS) {
    return _cachedModels;
  }

  // Fresh check — is opencode even installed?
  const hasOpenCode = await commandExists("opencode");
  if (!hasOpenCode) {
    _cachedModels = [];
    _cacheTimestamp = Date.now();
    return [];
  }

  try {
    const result = await runCommand("opencode", ["models", "opencode"], {
      timeoutMs: 15_000,
    });

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      _cachedModels = [];
      _cacheTimestamp = Date.now();
      return [];
    }

    _cachedModels = parseModelsOutput(result.stdout);
    _cacheTimestamp = Date.now();
    return _cachedModels;
  } catch {
    _cachedModels = [];
    _cacheTimestamp = Date.now();
    return [];
  }
}

/**
 * Get the single best free model available, or null if none.
 */
export async function getBestFreeModel(): Promise<DiscoveredFreeModel | null> {
  const models = await discoverFreeModels();
  return models.length > 0 ? models[0] : null;
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/tools/free-models.ts
git commit -m "feat: add free model discovery with TTL cache and CLI parsing"
```

---

## Chunk 2: Routing + Delegation

### Task 4: Add routing escape hatch

**Files:**
- Modify: `src/tools/route.ts:93-172`

- [ ] **Step 1: Add import for getBestFreeModel**

At the top of `src/tools/route.ts`, add after the existing imports:

```typescript
import { getBestFreeModel } from "./free-models.js";
```

- [ ] **Step 2: Change routeTask to async and add escape hatch**

The function signature changes from:
```typescript
export function routeTask(
```
to:
```typescript
export async function routeTask(
```

Then, in the body of `routeTask()`, after the `primaryModel` and `fallback` are computed (after line 153) and before the `reasoning` is built (line 155), insert the free model escape hatch:

```typescript
  // ── Free model escape hatch ──────────────────────────────────────
  // When 2+ paid services are critical, try free OpenCode models
  let freeModelOverride: { qualifiedName: string } | null = null;
  const criticalCount = [codexLevel, claudeLevel, zaiLevel].filter((l) => l === "critical").length;

  if (
    criticalCount >= 2 &&
    classification.complexity !== "architectural" &&
    !classification.is_ui_related
  ) {
    const freeModel = await getBestFreeModel();
    if (freeModel) {
      freeModelOverride = freeModel;
    }
  }
```

Then, after the `reasoning` is built but before the return statement, wrap the return to apply the override:

Replace the return block (lines 164-172) with:

```typescript
  if (freeModelOverride) {
    return {
      recommended_model: freeModelOverride.qualifiedName,
      recommended_service: "opencode" as ServiceType,
      reasoning: reasoning + ". FREE MODEL OVERRIDE: 2+ services critical, using free model" +
        ` (fallback: ${primaryModel?.id ?? "glm-4.7"}@${preferred.service})`,
      fallback_model: primaryModel?.id ?? "glm-4.7",
      fallback_service: preferred.service,
      cost_tier: "budget",
    };
  }

  return {
    recommended_model: primaryModel?.id ?? "glm-4.7",
    recommended_service: preferred.service,
    reasoning,
    fallback_model: fallback.model?.id ?? "glm-4.5-air",
    fallback_service: fallback.service,
    cost_tier: preferred.tier,
  };
```

- [ ] **Step 3: Update callers of routeTask to await it**

`routeTask` is now async. Check all call sites and add `await`:

1. `src/index.ts` line 125: `const decision = routeTask(...)` → `const decision = await routeTask(...)`
2. `src/tools/delegate.ts` line 529 (inside `parallelDelegate`): The `routeTask(...)` call is inside a synchronous `.map()` callback. The callback must become `async` and the `.map()` must be wrapped with `Promise.all()`.

Change (around line 515):
```typescript
  const assignments = subtasks.map((subtask) => {
```
to:
```typescript
  const assignments = await Promise.all(subtasks.map(async (subtask) => {
```

And change the closing of the `.map()` (around line 540):
```typescript
  });
```
to:
```typescript
  }));
```

Then add `await` to the `routeTask` call at line 529:
```typescript
    const routing = await routeTask(classification, quotaStatuses);
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: Clean compile. The async change propagates cleanly since `parallelDelegate` is already async and all other callers are in async functions.

- [ ] **Step 5: Commit**

```bash
git add src/tools/route.ts src/index.ts src/tools/delegate.ts
git commit -m "feat: add free model escape hatch in router when 2+ services critical"
```

---

### Task 5: Add delegateToOpenCode

**Files:**
- Modify: `src/tools/delegate.ts:64-88` (dispatchToService switch)

- [ ] **Step 1: Add the "opencode" case to dispatchToService**

In `src/tools/delegate.ts`, in the `dispatchToService` function switch statement, add before the `default` case:

```typescript
    case "opencode":
      return await delegateToOpenCode(prompt, model, cwd, timeoutMs);
```

- [ ] **Step 2: Add the delegateToOpenCode function**

Add after the `delegateToZaiViaClaude` function (after line 315), before the parallel delegation section:

```typescript
async function delegateToOpenCode(
  prompt: string,
  model: string,
  cwd: string,
  timeoutMs: number
): Promise<DelegationResult> {
  // model is already a qualifiedName like "opencode/big-pickle"
  console.error(`[OptimizerMCP] Delegating to free model via OpenCode: ${model}`);
  const args = ["run", "-m", model, "--", prompt];
  const result = await runCommand("opencode", args, { cwd, timeoutMs });

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: "",
      error: `OpenCode free model exited with code ${result.exitCode}: ${result.stderr}`,
      model_used: model,
      service_used: "opencode",
      estimated_tokens: 0,
    };
  }

  return {
    success: true,
    output: result.stdout.trim(),
    model_used: model,
    service_used: "opencode",
    estimated_tokens: 0,
  };
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
git add src/tools/delegate.ts
git commit -m "feat: add delegateToOpenCode for free model delegation"
```

---

### Task 6: Update spread strategy for opencode

**Files:**
- Modify: `src/tools/delegate.ts` (applySpreadStrategy function, ~line 423-458)

- [ ] **Step 1: Skip opencode from spread redistribution**

In the `applySpreadStrategy` function, the `maxPerService` check should not penalize opencode since free models have no quota. Add an early return at the top of the redistribution loop:

In the `for (const [service, count] of counts)` loop, add after `if (count <= maxPerService) continue;`:

```typescript
    // Don't redistribute away from opencode — free models have no quota
    if (service === "opencode") continue;
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/tools/delegate.ts
git commit -m "feat: exempt opencode from spread strategy redistribution"
```

---

## Chunk 3: Schema, Quota, and Documentation

### Task 7: Update index.ts — Schema enums and displayService

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update displayService()**

Change `displayService` (line 17-19) from:
```typescript
function displayService(service: string): string {
  return service === "zai" ? "zhipuai" : service;
}
```
to:
```typescript
function displayService(service: string): string {
  if (service === "zai") return "zhipuai";
  if (service === "opencode") return "opencode (free)";
  return service;
}
```

- [ ] **Step 2: Add "opencode" to delegate_task enums**

In the `delegate_task` tool registration (line 200 and 206), add `"opencode"` to both `target_service` and `fallback_service` enum arrays:

```typescript
      target_service: z
        .enum(["codex", "claude", "zai", "zhipuai", "opencode"])
```
```typescript
      fallback_service: z
        .enum(["codex", "claude", "zai", "zhipuai", "opencode"])
```

Also update the normalizer (line 218) to handle "opencode":
```typescript
    const normalizedService = (target_service === "zhipuai" ? "zai" : target_service) as "codex" | "claude" | "zai" | "opencode";
    const normalizedFallback = (fallback_service === "zhipuai" ? "zai" : fallback_service) as "codex" | "claude" | "zai" | "opencode" | undefined;
```

- [ ] **Step 3: Add "opencode" to parallel_delegate subtask enum**

In the `parallel_delegate` tool registration (line 507), add `"opencode"` to the subtask's `target_service` enum:

```typescript
            target_service: z
              .enum(["codex", "claude", "zai", "zhipuai", "opencode"])
```

Also update the normalizer in the handler (line 546):
```typescript
        targetService: s.target_service === "zhipuai" ? "zai" : s.target_service,
```
This already works since "opencode" passes through unchanged.

- [ ] **Step 4: Add "opencode" to record_usage enum**

In the `record_usage` tool (line 449):
```typescript
      service: z.enum(["codex", "claude", "zai", "opencode"]).describe("Which service was used"),
```

- [ ] **Step 5: Add "opencode" to check_quota enum**

In the `check_quota` tool (line 156):
```typescript
      service: z
        .enum(["codex", "claude", "zai", "opencode"])
        .optional()
```

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: add opencode to all tool schema enums and displayService"
```

---

### Task 8: Update check_available_tools output

**Files:**
- Modify: `src/index.ts` (check_available_tools handler, ~line 397-437)

- [ ] **Step 1: Add import for discoverFreeModels**

At the top of `src/index.ts`, add:
```typescript
import { discoverFreeModels } from "./tools/free-models.js";
```

- [ ] **Step 2: Add free model status to tool output**

In the `check_available_tools` handler, after the existing tool status lines (after the Distill line, ~line 411), add:

```typescript
    // Show free model availability
    const freeModels = await discoverFreeModels();
    if (freeModels.length > 0) {
      lines.push(`  Free models (OpenCode): ${freeModels.length} available (best: ${freeModels[0].model})`);
    } else if (tools.opencode) {
      lines.push(`  Free models (OpenCode): none detected`);
    } else {
      lines.push(`  Free models (OpenCode): N/A (OpenCode not installed)`);
    }
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: show free model availability in check_available_tools"
```

---

### Task 9: Update quota budget advice

**Files:**
- Modify: `src/tools/quota.ts:42-70`

- [ ] **Step 1: Add import for getBestFreeModel**

At the top of `src/tools/quota.ts`, add:
```typescript
import { getBestFreeModel } from "./free-models.js";
```

- [ ] **Step 2: Change checkQuota to async**

Change the function signature from:
```typescript
export function checkQuota(service?: string): QuotaReport {
```
to:
```typescript
export async function checkQuota(service?: string): Promise<QuotaReport> {
```

- [ ] **Step 3: Add free model awareness to the "all three critical" advice**

In the budget advice section, after the existing `if (claudePercent > 80 && codexPercent > 80 && zaiPercent > 80)` block (line 42-45), modify the advice to check for free models:

Replace the "CRITICAL: All three services" block (lines 42-45) with:
```typescript
  if (claudePercent > 80 && codexPercent > 80 && zaiPercent > 80) {
    const freeModel = await getBestFreeModel();
    if (freeModel) {
      budget_advice =
        "CRITICAL: All three services near limits. Free models available via OpenCode — " +
        `routing will auto-select them (best: ${freeModel.model}). ` +
        "Consider waiting for the 5-hour window to reset for premium tasks.";
    } else {
      budget_advice =
        "CRITICAL: All three services near limits. Use only budget models. " +
        "Consider waiting for the 5-hour window to reset.";
    }
  }
```

Also update the "Claude and Codex near limits" block (line 46-49):
```typescript
  } else if (claudePercent > 80 && codexPercent > 80) {
    const freeModel = await getBestFreeModel();
    budget_advice =
      "Claude and Codex near limits. Route work to Z.AI. " +
      "Use glm-4.5-air for simple tasks, glm-4.7 for moderate." +
      (freeModel ? ` Free models also available (${freeModel.model}).` : "");
```

- [ ] **Step 4: Update the caller in index.ts**

In `src/index.ts`, the `check_quota` handler calls `checkQuota()`. Since it's now async, add `await`:

Line 162: `const report = checkQuota(service)` → `const report = await checkQuota(service)`

(The handler is already async, so this is a safe change.)

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/tools/quota.ts src/index.ts
git commit -m "feat: add free model awareness to budget advice"
```

---

### Task 10: Update AGENTS.md

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add free model section to AGENTS.md**

After the "Three-Service Routing" table (line 105), add a new section:

```markdown
## Free Model Fallback

When 2+ of the 3 paid services (Claude, Codex, Z.AI) hit critical quota levels (>80%), the optimizer automatically discovers and routes to free models available in OpenCode's marketplace.

**How it works:**
- Triggered automatically when 2+ services are critical — no configuration needed
- Discovers available free models via `opencode models opencode` (cached 5 minutes)
- Ranks models by name heuristic and selects the best available
- Original routing decision becomes the fallback if free model fails

**Exclusions:**
- UI tasks always use Claude (computer-use required)
- Architectural tasks always use premium models
- If no free models are currently available, normal routing proceeds

**Manual targeting:** You can also explicitly target a free model:
```json
{ "prompt": "...", "target_service": "opencode", "target_model": "opencode/big-pickle" }
```

**Requirements:** OpenCode must be installed (`brew install anomalyco/tap/opencode`).
```

- [ ] **Step 2: Update the Tool Reference table**

No new tools — the existing tools gain the `"opencode"` service option. Update the routing table to add:

```markdown
| Quota critical (2+ services) | Free model (auto) | Original route |
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: add free model fallback section to AGENTS.md"
```

---

## Chunk 4: Build, Verify, Deploy

### Task 11: Full build and smoke test

- [ ] **Step 1: Clean build**

```bash
cd "/Volumes/Storage VIII/Programming/OptimizerMCP"
rm -rf build
npm run build
```

Expected: Clean compile, zero errors.

- [ ] **Step 2: Smoke test — verify server starts and lists tools**

```bash
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | timeout 5 node build/index.js 2>/dev/null || true
```

Expected: JSON output listing all 10 tools with the new `"opencode"` enum values visible in schemas.

- [ ] **Step 3: Verify stderr startup log**

```bash
echo '' | timeout 2 node build/index.js 2>&1 1>/dev/null || true
```

Expected: "OptimizerMCP server running on stdio" and tool list in stderr.

- [ ] **Step 4: Commit any fixes if needed, then push**

```bash
git push origin main
```

---

### Task 12: Deploy to laptop

- [ ] **Step 1: Deploy via SSH**

```bash
ssh gary@Garys-Laptop.local "cd ~/Programming/OptimizerMCP && git pull && PATH=/opt/homebrew/bin:\$PATH npm install && PATH=/opt/homebrew/bin:\$PATH npm run build"
```

Expected: Clean build on laptop.

- [ ] **Step 2: Verify**

Confirm the build completed successfully on both machines.
