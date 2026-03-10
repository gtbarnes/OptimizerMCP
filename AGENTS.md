# OptimizerMCP Instructions

You have access to the OptimizerMCP tools. Follow this workflow for EVERY task:

## Before Starting ANY Task

1. **Classify first:** Call `classify_task` with the user's request to determine complexity
2. **Check budget:** Call `check_quota` to see remaining capacity across services
3. **Get routing:** Call `recommend_model` with the classification to pick the optimal model

## During Task Execution

4. **Use optimized context:** Call `optimize_context` before sending large code blocks or CLI output to any model. This compresses content and saves tokens.
5. **Project overview:** Call `get_project_summary` instead of reading many files individually
6. **Delegate when needed:** If `recommend_model` suggests a different service, use `delegate_task` to route the work there. **Always pass `fallback_model` and `fallback_service`** from the routing decision so delegation auto-retries on failure.

## After Task Completion

7. **Record usage:** Call `record_usage` to keep quota tracking accurate

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

## Optimization Preferences

- Prefer symbol lookups over full file reads
- Prefer graph queries over grep-based exploration
- Compress all CLI output before processing
- Use `get_project_summary` for orientation instead of manual exploration
