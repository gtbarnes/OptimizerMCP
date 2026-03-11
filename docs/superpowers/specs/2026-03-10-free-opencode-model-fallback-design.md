# Free OpenCode Model Fallback — Design Spec

**Date:** 2026-03-10
**Status:** Approved

## Problem

When 2+ of the 3 paid services (Claude, Codex, Z.AI) hit critical quota levels, the MCP has no escape valve. Users must either wait for quota reset or accept degraded routing. OpenCode's marketplace offers rotating free models that could fill this gap at zero cost.

## Design Decisions

- **Trigger:** Any 2 of 3 main services at critical quota level (as defined by `getQuotaLevel()` returning `"critical"`)
- **Discovery:** Runtime via `opencode models opencode` CLI, cached 5 minutes
- **Selection:** Name-based heuristic ranking of available free models
- **Approach:** New `"opencode"` service type (Approach A) — clean separation from existing services

## Architecture

### 1. Type Changes (`src/config/models.ts`)

Expand `ServiceType` union:
```typescript
type ServiceType = "codex" | "claude" | "zai" | "opencode";
```

No changes to `ModelDef`, `models.json`, or `PlanLimits`. Free models exist only in memory as `DiscoveredFreeModel` objects.

### 2. Discovery Layer (new file: `src/tools/free-models.ts`, ~80 lines)

```typescript
interface DiscoveredFreeModel {
  provider: string;       // e.g. "opencode"
  model: string;          // e.g. "big-pickle"
  qualifiedName: string;  // "opencode/big-pickle"
  rank: number;           // heuristic quality score
}
```

- `discoverFreeModels()` — checks `commandExists("opencode")` first (not cached — fresh check each call), then runs `opencode models opencode`, parses output, ranks by name heuristic, returns sorted best-first
- TTL cache: 5-minute expiry on the parsed model list. Returns empty array on CLI failure (graceful degradation)
- `getBestFreeModel()` — convenience, returns top-ranked model or null

**CLI output format and parsing:**

`opencode models opencode` outputs a table like:
```
  Model                Provider    Context  Output
  big-pickle           opencode    128000   16384
  gpt-5-nano           opencode    128000   16384
  mimo-v2-flash-free   opencode    128000   16384
  minimax-m2.5-free    opencode    128000   16384
```

Parsing approach: skip header lines, split each remaining line on whitespace, extract the first column (model name) and second column (provider). The `qualifiedName` is `"<provider>/<model>"`. If the output format is unrecognizable (no lines with 4+ whitespace-separated columns), return empty array.

**Name heuristic ranking:**
- Higher version numbers in name -> higher rank
- "nano", "mini", "flash" in name -> penalty
- "free" suffix -> slight penalty
- Recognized prefixes (gpt, glm, mimo) -> slight bonus

### 3. Routing Escape Hatch (`src/tools/route.ts`)

After normal routing completes in `routeTask()`, but before returning:

```
// Save the original routing result
originalModel = recommended_model
originalService = recommended_service

criticalCount = count of [claude, codex, zai] where getQuotaLevel() === "critical"
if criticalCount >= 2:
  freeModel = getBestFreeModel()
  if freeModel exists AND NOT is_ui_related AND complexity !== "architectural":
    set recommended_model = freeModel.qualifiedName
    set recommended_service = "opencode"
    set fallback_model = originalModel
    set fallback_service = originalService
    set cost_tier = "budget"
    append "FREE MODEL OVERRIDE: 2+ services critical, using free model" to reasoning
```

Key detail: the **original** routing decision (what the router would have picked without the override) becomes the **fallback**. This way, if the free model delegation fails, auto-retry uses the best paid option. This replaces the generic `pickFallback()` result — the escape hatch explicitly sets `fallback_model` and `fallback_service` to the original primary choice.

### 4. Delegation (`src/tools/delegate.ts`)

New `"opencode"` case in `dispatchToService()` switch, calling `delegateToOpenCode()`:

```
opencode run -m <model> -- <prompt>
```

**Model name convention:** `delegateToOpenCode()` receives the `qualifiedName` (e.g. `"opencode/big-pickle"`) as the `model` parameter and passes it directly to `-m`. This is a convention difference from the other services (which use bare names like `"glm-4.7"`), but the `opencode run` CLI requires the `provider/model` format, same as the existing Z.AI path which constructs `"zhipuai-coding-plan/glm-4.7"`. The delegation layer already handles slash-qualified names.

Returns `DelegationResult` with `service_used: "opencode"`.

Records usage via `recordUsage()` with `service: "opencode"` for audit trail. No quota impact since `getQuotaStatus()` filters by the three known paid services.

### 5. Schema Updates (`src/index.ts`)

Add `"opencode"` to enum arrays in:
- `delegate_task` target_service and fallback_service
- `parallel_delegate` subtask target_service
- `record_usage` service
- `check_quota` service (optional filter)

**Excluded:** `update_model_registry` does NOT get `"opencode"` — free models are ephemeral, not persisted to `models.json`.

**`displayService()` update:** Add `"opencode"` -> `"opencode (free)"` mapping for user-facing output.

### 6. Budget Advice (`src/tools/quota.ts`)

When 2+ services critical and free models available, append to advice:
"Free models available via OpenCode — routing will auto-select them."

### 7. Tool Status (`check_available_tools`)

Add line: `Free models (OpenCode): N available (best: <name>)` or `"none detected"`.

### 8. AGENTS.md

Document: auto-activation trigger, no config needed, rotation/caching behavior, UI/architectural exclusions, manual targeting option.

### 9. Parallel Delegation Interaction

When the escape hatch fires inside `routeTask()`, it applies per-subtask in `parallelDelegate()`. The `spread` strategy should treat `"opencode"` as a valid service for distribution purposes — if multiple subtasks land on opencode, spread does NOT redistribute them away (free models have no quota to exhaust). The `spread` strategy's `maxPerService` check simply doesn't penalize opencode accumulation.

## Exclusions

- UI tasks always force Claude (computer-use requirement)
- Architectural tasks skip free model override (too important)
- If no free models available, normal routing proceeds unchanged

## Files Changed

| File | Change |
|------|--------|
| `src/config/models.ts` | Add `"opencode"` to `ServiceType` |
| `src/tools/free-models.ts` | **New file** — discovery, caching, ranking |
| `src/tools/route.ts` | Escape hatch after normal routing |
| `src/tools/delegate.ts` | New `delegateToOpenCode()` + switch case |
| `src/tools/quota.ts` | Free model awareness in budget advice |
| `src/index.ts` | Schema enums, `displayService()`, tool status output |
| `AGENTS.md` | Documentation section |
| `src/tracking/usage-store.ts` | No changes (string column accepts "opencode") |
| `src/tools/classify.ts` | No changes |
| `src/tools/optimize.ts` | No changes |
| `src/utils/subprocess.ts` | No changes (existing `runCommand` + `commandExists` suffice) |
