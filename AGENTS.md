# OptimizerMCP Instructions

You have access to the OptimizerMCP tools. Follow this workflow for EVERY task:

## Before Starting ANY Task

1. **Classify first:** Call `classify_task` with the user's request to determine complexity
2. **Check budget:** Call `check_quota` to see remaining capacity across services
3. **Get routing:** Call `recommend_model` with the classification to pick the optimal model

## During Task Execution

4. **Use optimized context:** Call `optimize_context` before sending large code blocks or CLI output to any model. This compresses content and saves tokens (uses Distill/Ollama when available for 95-99% savings).
5. **Project overview:** Call `get_project_summary` instead of reading many files individually
6. **Delegate when needed:** If `recommend_model` suggests a different service, use `delegate_task` to route the work there. **Always pass `fallback_model` and `fallback_service`** from the routing decision so delegation auto-retries on failure.

## Parallel Delegation (for decomposable tasks)

When a task can be split into independent subtasks across different domains:

7. **Auto-split (preferred):** Call `parallel_delegate` with `task` and `auto_split: true`. The optimizer uses a local Ollama model to decompose the task and route subtasks to different services. This requires Ollama to be installed.

8. **Manual split (fallback):** If Ollama isn't available or you prefer control, call `parallel_delegate` with a `subtasks` array:
   - Assign unique IDs to each subtask (e.g., 'backend-api', 'frontend-form', 'tests')
   - Write clear, self-contained prompts for each subtask
   - Let the optimizer auto-route — do NOT specify target_service unless a subtask absolutely requires a specific service (e.g., UI work that needs Claude computer-use)
   - Use `depends_on` only when one subtask truly needs another's output

### When to use `parallel_delegate` vs `delegate_task`:
- **`delegate_task`**: Single task, single service dispatch
- **`parallel_delegate`**: 2+ independent subtasks that can run simultaneously on different services

### Good decomposition example:
Task: "Add user authentication with login page and tests"
- Subtask 1: "Implement JWT authentication middleware for Express" → routes to Z.AI
- Subtask 2: "Create login/signup React components with form validation" → forces Claude (UI)
- Subtask 3: "Write integration tests for auth endpoints" → routes to Z.AI

### Bad decomposition:
- Subtasks that are too small (< 5 minutes of work each)
- Subtasks that heavily depend on each other's output
- A single task artificially split (just use delegate_task)

## After Task Completion

9. **Record usage:** Call `record_usage` to keep quota tracking accurate

## Three-Service Routing

- **Z.AI (OpenCode):** Cheapest option for trivial/simple tasks — glm-4.5-air, glm-4.7
- **Claude:** Required for UI/visual tasks (computer-use), preferred for complex/architectural work
- **Codex:** Fallback when other services are at quota

## Model Selection Rules

- **Trivial tasks** (typos, renames, version bumps): Z.AI budget (glm-4.5-air)
- **Simple tasks** (single function, small bug fix): Z.AI mid (glm-4.7)
- **Moderate tasks** (new feature, refactor): Claude mid (sonnet) or Z.AI mid when conserving
- **Complex/Architectural tasks**: Claude flagship (opus), Z.AI flagship (glm-5) as fallback
- **UI tasks** (CSS, layout, components, SwiftUI, etc.): Always Claude (computer-use)
- **When quota is low**: Downgrade model tier, never exceed budget

## Optimization Tools

The optimizer integrates with these tools when available (all optional, auto-detected):
- **Distill + Ollama:** Semantic compression via local LLM (95-99% savings on CLI output)
- **RTK / tokf:** Pattern-based CLI output compression (60-90% savings)
- **SymDex:** Symbol-level code indexing (up to 97% savings on code lookups)
- Prefer symbol lookups over full file reads
- Compress all CLI output before processing
- Use `get_project_summary` for orientation instead of manual exploration
