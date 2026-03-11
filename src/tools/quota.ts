import {
  getQuotaStatus,
  getUsageSummary,
  getTokensInWindow,
  type QuotaStatus,
} from "../tracking/usage-store.js";
import { getBestFreeModel } from "./free-models.js";

export interface QuotaReport {
  statuses: QuotaStatus[];
  summary: string;
  should_use_opus: boolean;
  should_use_flagship: boolean;
  budget_advice: string;
}

export async function checkQuota(service?: string): Promise<QuotaReport> {
  // OpenCode free models have no quota — return immediately with helpful info
  if (service === "opencode") {
    const freeModel = await getBestFreeModel();
    return {
      statuses: [],
      summary: "OpenCode free models have no quota limits.",
      should_use_opus: false,
      should_use_flagship: false,
      budget_advice: freeModel
        ? `Free models available via OpenCode — no quota limits apply. Best model: ${freeModel.model}. ` +
          `Use target_service: "opencode" with target_model: "${freeModel.qualifiedName}" to delegate.`
        : "No free models currently detected. Install OpenCode (brew install anomalyco/tap/opencode) " +
          "and ensure free models are available in the marketplace.",
    };
  }

  const allStatuses = getQuotaStatus();
  const statuses = service
    ? allStatuses.filter((s) => s.service === service)
    : allStatuses;

  const summary = getUsageSummary();

  // Determine if we should use expensive models
  const claudeStatus = allStatuses.find((s) => s.service === "claude");
  const codexStatus = allStatuses.find((s) => s.service === "codex");
  const zaiStatus = allStatuses.find((s) => s.service === "zai");

  const claudePercent = claudeStatus?.percent_5h ?? 0;
  const codexPercent = codexStatus?.percent_5h ?? 0;
  const zaiPercent = zaiStatus?.percent_5h ?? 0;

  // Opus always requires user confirmation — never auto-recommend
  const should_use_opus = false;
  const should_use_flagship = codexPercent < 40 || claudePercent < 40;

  // Token usage for extra context
  const claudeTokens = getTokensInWindow("claude", 5);
  const codexTokens = getTokensInWindow("codex", 5);
  const zaiTokens = getTokensInWindow("zai", 5);

  let budget_advice: string;
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
  } else if (claudePercent > 80 && codexPercent > 80) {
    const freeModel = await getBestFreeModel();
    budget_advice =
      "Claude and Codex near limits. Route work to Zhipu AI. " +
      "Use glm-4.5-air for simple tasks, glm-4.7 for moderate." +
      (freeModel ? ` Free models also available (${freeModel.model}).` : "");
  } else if (claudePercent > 80 && zaiPercent > 80) {
    const freeModel = await getBestFreeModel();
    budget_advice =
      "Claude and Zhipu AI near limits. Route work to Codex. " +
      "Use codex-mini for simple tasks." +
      (freeModel ? ` Free models also available (${freeModel.model}).` : "");
  } else if (codexPercent > 80 && zaiPercent > 80) {
    const freeModel = await getBestFreeModel();
    budget_advice =
      "Codex and Zhipu AI near limits. Route work to Claude. " +
      "Use haiku for simple tasks, sonnet for moderate." +
      (freeModel ? ` Free models also available (${freeModel.model}).` : "");
  } else if (claudePercent > 80) {
    budget_advice =
      "Claude near limit. Route to Zhipu AI (glm-4.7) or Codex. " +
      "Use codex-mini for simple tasks, Zhipu AI for coding tasks.";
  } else if (codexPercent > 80) {
    budget_advice =
      "Codex near limit. Route to Zhipu AI or Claude. " +
      "Use glm-4.5-air/haiku for simple tasks, glm-4.7/sonnet for moderate.";
  } else if (zaiPercent > 80) {
    budget_advice =
      "Zhipu AI near limit. Route to Codex or Claude for budget tasks. " +
      "Zhipu AI quotas are generous — this may indicate heavy use.";
  } else if (claudePercent > 50 || codexPercent > 50) {
    budget_advice =
      "Moderate usage on premium services. Prefer Zhipu AI (glm-4.7) for cost savings. " +
      "Save flagship models for complex/architectural tasks only.";
  } else {
    budget_advice =
      "Good budget headroom. Full model range available. " +
      "Still prefer Zhipu AI for routine tasks to conserve Claude/Codex quota.";
  }

  budget_advice += `\n\nEstimated tokens used (5h window):`;
  budget_advice += `\n  Claude: ~${claudeTokens.input + claudeTokens.output} total tokens`;
  budget_advice += `\n  Codex: ~${codexTokens.input + codexTokens.output} total tokens`;
  budget_advice += `\n  Zhipu AI: ~${zaiTokens.input + zaiTokens.output} total tokens`;

  return {
    statuses,
    summary,
    should_use_opus,
    should_use_flagship,
    budget_advice,
  };
}
