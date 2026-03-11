import type { Complexity, TaskClassification } from "./classify.js";
import type { QuotaStatus } from "../tracking/usage-store.js";
import { getModelRegistry, type ModelDef, type ServiceType } from "../config/models.js";
import { getBestFreeModel } from "./free-models.js";

export interface RoutingDecision {
  recommended_model: string;
  recommended_service: ServiceType;
  reasoning: string;
  fallback_model: string;
  fallback_service: ServiceType;
  cost_tier: string;
  /** When true, Codex MUST ask the user before delegating (e.g. opus). */
  requires_confirmation: boolean;
  /** Reason confirmation is needed (shown to user). */
  confirmation_reason?: string;
  /** The premium model that requires confirmation. Use this if user approves. */
  premium_model?: string;
}

type QuotaLevel = "high" | "moderate" | "low" | "critical";

function getQuotaLevel(percent: number): QuotaLevel {
  if (percent < 20) return "high";
  if (percent < 50) return "moderate";
  if (percent < 80) return "low";
  return "critical";
}

interface RouteTarget {
  service: ServiceType;
  tier: ModelDef["tier"];
}

// Three-service routing matrix: [complexity][worst_quota_level]
// Zhipu AI is the cost-efficient middle ground — cheaper than Claude, more capable than codex-mini
const ROUTING_MATRIX: Record<Complexity, Record<QuotaLevel, RouteTarget>> = {
  trivial: {
    high:     { service: "zai", tier: "budget" },    // glm-4.5-air — cheapest option
    moderate: { service: "zai", tier: "budget" },
    low:      { service: "zai", tier: "budget" },
    critical: { service: "zai", tier: "budget" },
  },
  simple: {
    high:     { service: "zai", tier: "mid" },       // glm-4.7 — great for simple coding
    moderate: { service: "zai", tier: "mid" },
    low:      { service: "zai", tier: "budget" },
    critical: { service: "zai", tier: "budget" },
  },
  moderate: {
    high:     { service: "claude", tier: "mid" },    // sonnet for quality
    moderate: { service: "zai", tier: "mid" },       // glm-4.7 as cost saver
    low:      { service: "zai", tier: "mid" },
    critical: { service: "zai", tier: "mid" },
  },
  complex: {
    high:     { service: "claude", tier: "flagship" }, // opus for complex work
    moderate: { service: "claude", tier: "mid" },      // sonnet when conserving
    low:      { service: "zai", tier: "flagship" },    // glm-5 as fallback
    critical: { service: "zai", tier: "mid" },         // glm-4.7 when desperate
  },
  architectural: {
    high:     { service: "claude", tier: "flagship" },
    moderate: { service: "claude", tier: "flagship" },
    low:      { service: "claude", tier: "mid" },
    critical: { service: "zai", tier: "flagship" },  // glm-5 when Claude is exhausted
  },
};

function findBestModel(service: ServiceType, tier: ModelDef["tier"]): ModelDef | undefined {
  const registry = getModelRegistry();
  let model = registry.models.find((m) => m.service === service && m.tier === tier);
  if (model) return model;

  const tierOrder: ModelDef["tier"][] = ["budget", "mid", "high", "flagship"];
  const targetIdx = tierOrder.indexOf(tier);

  for (let i = targetIdx - 1; i >= 0; i--) {
    model = registry.models.find((m) => m.service === service && m.tier === tierOrder[i]);
    if (model) return model;
  }
  for (let i = targetIdx + 1; i < tierOrder.length; i++) {
    model = registry.models.find((m) => m.service === service && m.tier === tierOrder[i]);
    if (model) return model;
  }
  return undefined;
}

function pickFallback(primaryService: ServiceType): { service: ServiceType; model: ModelDef | undefined } {
  // Fallback priority: Zhipu AI (cheapest) > Codex > Claude
  const fallbackOrder: ServiceType[] = ["zai", "codex", "claude"];
  for (const service of fallbackOrder) {
    if (service === primaryService) continue;
    const model = findBestModel(service, "budget");
    if (model) return { service, model };
  }
  return { service: "zai", model: findBestModel("zai", "budget") };
}

export async function routeTask(
  classification: TaskClassification,
  quotaStatuses: QuotaStatus[]
): Promise<RoutingDecision> {
  const codexQuota = quotaStatuses.find((q) => q.service === "codex");
  const claudeQuota = quotaStatuses.find((q) => q.service === "claude");
  const zaiQuota = quotaStatuses.find((q) => q.service === "zai");

  const codexLevel = getQuotaLevel(codexQuota?.percent_5h ?? 0);
  const claudeLevel = getQuotaLevel(claudeQuota?.percent_5h ?? 0);
  const zaiLevel = getQuotaLevel(zaiQuota?.percent_5h ?? 0);

  // Use the worst non-ZAI quota level for the routing matrix
  // (since Zhipu AI is the overflow destination)
  const worstMainLevel = codexLevel === "critical" || claudeLevel === "critical"
    ? "critical"
    : codexLevel === "low" || claudeLevel === "low"
      ? "low"
      : codexLevel === "moderate" || claudeLevel === "moderate"
        ? "moderate"
        : "high";

  let preferred = ROUTING_MATRIX[classification.complexity][worstMainLevel];

  // Service-specific overrides based on actual quotas
  if (preferred.service === "claude" && claudeLevel === "critical") {
    // Claude exhausted — fall to Zhipu AI
    preferred = { service: "zai", tier: preferred.tier };
  } else if (preferred.service === "codex" && codexLevel === "critical") {
    // Codex exhausted — fall to Zhipu AI
    preferred = { service: "zai", tier: preferred.tier };
  } else if (preferred.service === "zai" && zaiLevel === "critical") {
    // Zhipu AI exhausted — try Codex for budget, Claude for premium
    if (preferred.tier === "budget" || preferred.tier === "mid") {
      preferred = codexLevel !== "critical"
        ? { service: "codex", tier: "budget" }
        : { service: "claude", tier: "budget" };
    } else {
      preferred = claudeLevel !== "critical"
        ? { service: "claude", tier: preferred.tier }
        : { service: "codex", tier: "high" };
    }
  }

  // Agentic tasks need capable models
  if (classification.is_agentic && preferred.tier === "budget") {
    preferred = { service: preferred.service, tier: "mid" };
  }

  // UI tasks must use Claude (computer-use capability)
  if (classification.is_ui_related && preferred.service !== "claude") {
    // Force Claude for anything UI — only Claude has computer-use
    const uiTier = preferred.tier === "budget" ? "mid" : preferred.tier;
    if (claudeLevel !== "critical") {
      preferred = { service: "claude", tier: uiTier };
    }
    // If Claude is critical, keep current service but note it in reasoning
  }

  const primaryModel = findBestModel(preferred.service, preferred.tier);
  const fallback = pickFallback(preferred.service);

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

  const reasoning = buildReasoning(
    classification,
    preferred,
    codexLevel,
    claudeLevel,
    zaiLevel,
    primaryModel
  );

  if (freeModelOverride) {
    return {
      recommended_model: freeModelOverride.qualifiedName,
      recommended_service: "opencode" as ServiceType,
      reasoning: reasoning + ". FREE MODEL OVERRIDE: 2+ services critical, using free model" +
        ` (fallback: ${primaryModel?.id ?? "glm-4.7"}@${preferred.service})`,
      fallback_model: primaryModel?.id ?? "glm-4.7",
      fallback_service: preferred.service,
      cost_tier: "budget",
      requires_confirmation: false,
    };
  }

  // ── Opus gate: NEVER auto-delegate to opus without user confirmation ──
  // Opus consumes ~4.5x more quota than sonnet (10 msgs/5h vs 45).
  // Downgrade to sonnet as default; keep opus as premium_model for manual upgrade.
  const isOpus = primaryModel?.id?.toLowerCase().includes("opus") ?? false;
  if (isOpus) {
    const sonnet = findBestModel("claude", "mid");
    return {
      recommended_model: sonnet?.id ?? "claude-sonnet-4-6",
      recommended_service: "claude",
      reasoning: reasoning + ". OPUS DOWNGRADED → sonnet (opus requires user confirmation)",
      fallback_model: fallback.model?.id ?? "glm-4.5-air",
      fallback_service: fallback.service,
      cost_tier: "mid",
      requires_confirmation: true,
      confirmation_reason: `Opus (${primaryModel!.id}) is ideal for this task but consumes ~4.5x more quota than sonnet. ` +
        `Ask user: "This looks like a ${classification.complexity} task — want me to use opus for better quality, or stick with sonnet?"`,
      premium_model: primaryModel!.id,
    };
  }

  return {
    recommended_model: primaryModel?.id ?? "glm-4.7",
    recommended_service: preferred.service,
    reasoning,
    fallback_model: fallback.model?.id ?? "glm-4.5-air",
    fallback_service: fallback.service,
    cost_tier: preferred.tier,
    requires_confirmation: false,
  };
}

function buildReasoning(
  classification: TaskClassification,
  preferred: RouteTarget,
  codexLevel: QuotaLevel,
  claudeLevel: QuotaLevel,
  zaiLevel: QuotaLevel,
  model: ModelDef | undefined
): string {
  const parts: string[] = [];

  parts.push(`Task: ${classification.complexity} (${classification.category})`);
  parts.push(`Quotas — Codex: ${codexLevel}, Claude: ${claudeLevel}, Zhipu AI: ${zaiLevel}`);
  parts.push(`Composite score: ${classification.signals.composite.toFixed(3)}`);

  if (model) {
    parts.push(
      `Selected ${model.id} (${model.service}, ${model.tier} tier, cost ${model.cost_weight})`
    );
  }

  if (classification.requires_multi_file) parts.push("Multi-file task");
  if (classification.requires_reasoning) parts.push("Requires reasoning");
  if (classification.is_agentic) parts.push("Agentic workflow detected");
  if (classification.is_ui_related) {
    parts.push(preferred.service === "claude"
      ? "UI task → forced Claude (computer-use)"
      : "UI task detected but Claude unavailable (critical quota)");
  }

  if (codexLevel === "critical" || claudeLevel === "critical") {
    parts.push("WARNING: Major service near quota");
  }

  if (preferred.service === "zai") {
    parts.push("Routed to Zhipu AI for cost efficiency");
  }

  return parts.join(". ");
}
