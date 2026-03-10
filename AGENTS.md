# OptimizerMCP — System Instructions

You have OptimizerMCP tools installed. These tools REPLACE your normal workflow for exploration, context gathering, and task routing. Do NOT fall back to manual file-by-file exploration when these tools can do the job.

## CRITICAL RULES

1. **DO NOT manually explore codebases file-by-file.** Use `get_project_summary` to orient yourself. If you need more detail on specific files, call `optimize_context` with those file paths — do NOT read them raw.
2. **DO NOT ignore routing decisions.** If `recommend_model` tells you to delegate to another service, USE `delegate_task` or `parallel_delegate`. Do not just proceed locally.
3. **DO NOT skip compression.** Any CLI output, large code block, or multi-file content MUST go through `optimize_context` before you process it. This saves 60-99% of tokens.
4. **Trust the tools.** If `get_project_summary` gives you enough context to proceed, STOP exploring and START working.

## Workflow (follow in order)

### Step 1: Classify + Route (do this ONCE at the start)

```
classify_task → check_quota → recommend_model
```

Call all three. The routing result tells you:
- Which service and model to use
- Whether to delegate or work locally
- Fallback model/service if primary fails

**If routing says delegate → delegate. Do not work locally instead.**

### Step 2: Understand the Project (if needed)

Call `get_project_summary` ONCE to get an optimized overview. This replaces:
- ❌ Listing directories manually
- ❌ Reading files one by one to understand structure
- ❌ Running `find`, `ls`, `tree` to explore

If the summary gives you enough context → move to Step 3.
If you need specific file contents → call `optimize_context` with `file_paths`.

### Step 3: Do the Work

- **Single task, different service recommended:** Use `delegate_task` with `fallback_model` and `fallback_service` from the routing result
- **Multi-part task (2+ independent pieces):** Use `parallel_delegate` with `auto_split: true` (preferred) or manual `subtasks` array
- **Working locally (routing says current service is optimal):** Proceed normally, but compress any large inputs through `optimize_context`

### Step 4: Record Usage

Call `record_usage` when done to keep quota tracking accurate.

## Tool Reference

| Tool | When to Use | Replaces |
|------|-------------|----------|
| `classify_task` | Start of every task | Your judgment about complexity |
| `check_quota` | After classify | Guessing about budget |
| `recommend_model` | After classify + quota | Picking models yourself |
| `delegate_task` | When routing says different service | Working locally on everything |
| `parallel_delegate` | 2+ independent subtasks | Sequential single-service work |
| `optimize_context` | Before processing any large content | Reading raw files/output |
| `get_project_summary` | Understanding a project | Manual file exploration |
| `record_usage` | After completing work | Nothing (new capability) |
| `update_model_registry` | New model released | Nothing (new capability) |
| `check_available_tools` | Debugging tool availability | Nothing (new capability) |

## Parallel Delegation Details

### Auto-split (preferred):
```json
{ "task": "full task description", "auto_split": true }
```
Ollama decomposes the task into 2-6 independent subtasks and routes each optimally.

### Manual split:
```json
{
  "subtasks": [
    { "id": "backend-api", "prompt": "Implement JWT auth middleware..." },
    { "id": "frontend-form", "prompt": "Create login/signup components..." },
    { "id": "tests", "prompt": "Write integration tests for auth...", "depends_on": ["backend-api"] }
  ]
}
```
- Let the optimizer auto-route each subtask (don't set `target_service` unless required)
- Only use `depends_on` when one subtask truly needs another's output
- Each subtask prompt must be self-contained

### Strategies:
- `spread` (default): Balances work across services
- `cheapest`: Minimizes cost
- `fastest`: No rebalancing, routes as classified

## Three-Service Routing

| Complexity | Primary | Fallback |
|-----------|---------|----------|
| Trivial (typos, renames) | Z.AI glm-4.5-air | Codex |
| Simple (single function) | Z.AI glm-4.7 | Codex |
| Moderate (new feature) | Claude sonnet | Z.AI glm-4.7 |
| Complex/Architectural | Claude opus | Z.AI glm-5 |
| UI/Visual (any) | Claude (always) | Claude (no fallback) |
| Low quota | Downgrade tier | Never exceed budget |

## Anti-Patterns (DO NOT DO THESE)

- ❌ Calling `classify_task` then ignoring the routing and working locally
- ❌ Reading 10+ files to understand a codebase instead of calling `get_project_summary`
- ❌ Processing raw CLI output without compressing through `optimize_context`
- ❌ Using `delegate_task` without passing `fallback_model`/`fallback_service`
- ❌ Splitting tasks into subtasks that depend heavily on each other
- ❌ Manually searching files after `get_project_summary` already gave you what you need
