import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type ServiceType = "codex" | "claude" | "zai" | "opencode";

export interface ModelDef {
  id: string;
  service: ServiceType;
  tier: "flagship" | "high" | "mid" | "budget";
  capabilities: string[];
  cost_weight: number;
  context_window: number;
  notes?: string;
}

export interface PlanLimits {
  codex_plus: {
    tasks_per_5h_min: number;
    tasks_per_5h_max: number;
    weekly_multiplier: number;
  };
  claude_pro: {
    opus_messages_per_5h: number;
    sonnet_messages_per_5h: number;
    haiku_messages_per_5h: number;
    weekly_multiplier: number;
  };
  zai_lite: {
    prompts_per_5h: number;
    weekly_prompts: number;
    glm5_multiplier: number;
    peak_hours_utc8: string;
  };
}

export interface ModelRegistry {
  models: ModelDef[];
  plan_limits: PlanLimits;
}

let _registry: ModelRegistry | null = null;

export function getModelRegistry(): ModelRegistry {
  if (_registry) return _registry;

  const configPath = join(__dirname, "..", "..", "config", "models.json");
  const raw = readFileSync(configPath, "utf-8");
  _registry = JSON.parse(raw) as ModelRegistry;
  return _registry;
}

/** Invalidate cached registry so next getModelRegistry() re-reads from disk. */
export function invalidateRegistryCache(): void {
  _registry = null;
}

export function getModel(id: string): ModelDef | undefined {
  return getModelRegistry().models.find((m) => m.id === id);
}

export function getModelsByService(service: ServiceType): ModelDef[] {
  return getModelRegistry().models.filter((m) => m.service === service);
}

export function getModelsByTier(tier: ModelDef["tier"]): ModelDef[] {
  return getModelRegistry().models.filter((m) => m.tier === tier);
}

export function getCheapestModel(
  service: ServiceType,
  requiredCapabilities: string[] = []
): ModelDef | undefined {
  return getModelsByService(service)
    .filter((m) =>
      requiredCapabilities.every((cap) => m.capabilities.includes(cap))
    )
    .sort((a, b) => a.cost_weight - b.cost_weight)[0];
}
