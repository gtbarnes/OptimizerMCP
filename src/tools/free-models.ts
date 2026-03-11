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

const BUDGET_PENALTIES = /nano|mini(?!max)|flash|tiny|small|lite/i;
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

// ── Discovery ────────────────────────────────────────────────────────

/**
 * Parse the tabular output of `opencode models opencode`.
 * Expected format:
 *   Model                Provider    Context  Output
 *   big-pickle           opencode    128000   16384
 *
 * Skips header lines. Extracts model name (col 0) and provider (col 1).
 * Strips ANSI escape codes that some CLIs inject for colored output.
 */
function parseModelsOutput(stdout: string): DiscoveredFreeModel[] {
  // Strip ANSI escape codes before parsing
  const cleaned = stdout.replace(/\x1B\[[0-9;]*m/g, "");
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
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
 * Results (including "no models found") are cached for 5 minutes.
 * Both commandExists and model discovery are re-run on cache expiry.
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
