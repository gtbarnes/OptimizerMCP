import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { getSettings } from "../config/settings.js";

export interface UsageEvent {
  service: string;
  model: string;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  task_complexity: string;
}

export interface QuotaStatus {
  service: string;
  used_5h: number;
  limit_5h: number;
  percent_5h: number;
  used_weekly: number;
  limit_weekly: number;
  percent_weekly: number;
  recommendation: string;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const settings = getSettings();
  const dir = dirname(settings.dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _db = new Database(settings.dbPath);
  _db.pragma("journal_mode = WAL");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      service TEXT NOT NULL,
      model TEXT NOT NULL,
      estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_output_tokens INTEGER NOT NULL DEFAULT 0,
      task_complexity TEXT NOT NULL DEFAULT 'unknown'
    );

    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_service ON usage_events(service);
  `);

  return _db;
}

export function recordUsage(event: UsageEvent): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO usage_events (service, model, estimated_input_tokens, estimated_output_tokens, task_complexity)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    event.service,
    event.model,
    event.estimated_input_tokens,
    event.estimated_output_tokens,
    event.task_complexity
  );
}

export function getUsageInWindow(service: string, windowHours: number): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM usage_events
    WHERE service = ? AND timestamp > datetime('now', ?)
  `).get(service, `-${windowHours} hours`) as { count: number } | undefined;

  return row?.count ?? 0;
}

export function getTokensInWindow(service: string, windowHours: number): { input: number; output: number } {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(estimated_input_tokens), 0) as input,
      COALESCE(SUM(estimated_output_tokens), 0) as output
    FROM usage_events
    WHERE service = ? AND timestamp > datetime('now', ?)
  `).get(service, `-${windowHours} hours`) as { input: number; output: number } | undefined;

  return { input: row?.input ?? 0, output: row?.output ?? 0 };
}

export function getQuotaStatus(): QuotaStatus[] {
  const settings = getSettings();
  const limits = settings.currentPlan;
  const results: QuotaStatus[] = [];

  // Codex quota
  const codexUsed5h = getUsageInWindow("codex", 5);
  const codexLimit5h = limits.codex === "plus" ? 80 : 500; // conservative middle estimate
  const codexUsedWeekly = getUsageInWindow("codex", 168); // 7 * 24
  const codexLimitWeekly = codexLimit5h * 7;

  results.push({
    service: "codex",
    used_5h: codexUsed5h,
    limit_5h: codexLimit5h,
    percent_5h: Math.round((codexUsed5h / codexLimit5h) * 100),
    used_weekly: codexUsedWeekly,
    limit_weekly: codexLimitWeekly,
    percent_weekly: Math.round((codexUsedWeekly / codexLimitWeekly) * 100),
    recommendation: codexUsed5h / codexLimit5h > 0.8
      ? "CONSERVE: Use codex-mini or delegate to Claude"
      : codexUsed5h / codexLimit5h > 0.5
        ? "MODERATE: Prefer budget models for simple tasks"
        : "NORMAL: Full model range available",
  });

  // Claude quota
  const claudeUsed5h = getUsageInWindow("claude", 5);
  const claudeLimit5h = limits.claude === "pro" ? 45 : 200; // sonnet-equivalent
  const claudeUsedWeekly = getUsageInWindow("claude", 168);
  const claudeLimitWeekly = claudeLimit5h * 5;

  results.push({
    service: "claude",
    used_5h: claudeUsed5h,
    limit_5h: claudeLimit5h,
    percent_5h: Math.round((claudeUsed5h / claudeLimit5h) * 100),
    used_weekly: claudeUsedWeekly,
    limit_weekly: claudeLimitWeekly,
    percent_weekly: Math.round((claudeUsedWeekly / claudeLimitWeekly) * 100),
    recommendation: claudeUsed5h / claudeLimit5h > 0.8
      ? "CONSERVE: Use Haiku only, or delegate to Codex/Z.AI"
      : claudeUsed5h / claudeLimit5h > 0.5
        ? "MODERATE: Prefer Sonnet/Haiku, avoid Opus"
        : "NORMAL: Full model range available",
  });

  // Z.AI quota
  const zaiUsed5h = getUsageInWindow("zai", 5);
  const zaiLimit5h = limits.zai === "lite" ? 120 : limits.zai === "pro" ? 600 : 1000;
  const zaiUsedWeekly = getUsageInWindow("zai", 168);
  const zaiLimitWeekly = limits.zai === "lite" ? 400 : limits.zai === "pro" ? 2000 : 5000;

  results.push({
    service: "zai",
    used_5h: zaiUsed5h,
    limit_5h: zaiLimit5h,
    percent_5h: Math.round((zaiUsed5h / zaiLimit5h) * 100),
    used_weekly: zaiUsedWeekly,
    limit_weekly: zaiLimitWeekly,
    percent_weekly: Math.round((zaiUsedWeekly / zaiLimitWeekly) * 100),
    recommendation: zaiUsed5h / zaiLimit5h > 0.8
      ? "CONSERVE: Z.AI near limit, route to Codex/Claude"
      : zaiUsed5h / zaiLimit5h > 0.5
        ? "MODERATE: Prefer glm-4.5-air for simple tasks"
        : "NORMAL: Full Z.AI model range available",
  });

  return results;
}

export function getUsageSummary(): string {
  const statuses = getQuotaStatus();
  const lines: string[] = ["=== Usage Summary ==="];

  for (const s of statuses) {
    lines.push(`\n${s.service.toUpperCase()}:`);
    lines.push(`  5-hour window: ${s.used_5h}/${s.limit_5h} tasks (${s.percent_5h}%)`);
    lines.push(`  Weekly: ${s.used_weekly}/${s.limit_weekly} tasks (${s.percent_weekly}%)`);
    lines.push(`  Status: ${s.recommendation}`);
  }

  return lines.join("\n");
}
