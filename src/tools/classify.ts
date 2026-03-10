/**
 * NadirClaw-style multi-signal task classifier.
 *
 * Instead of simple keyword matching, this uses a weighted scoring system
 * across multiple signal dimensions (like NadirClaw's centroid-based approach)
 * but without requiring an embedding model download.
 *
 * Signals:
 *   1. Keyword patterns (expanded, weighted)
 *   2. Structural analysis (code blocks, file refs, line count)
 *   3. Intent detection (question vs command, explore vs modify)
 *   4. Agentic detection (tool use, multi-step, system prompts)
 *   5. Scope analysis (single file vs multi-file vs codebase-wide)
 */

export type Complexity = "trivial" | "simple" | "moderate" | "complex" | "architectural";

export interface TaskClassification {
  complexity: Complexity;
  estimated_tokens: number;
  requires_multi_file: boolean;
  requires_reasoning: boolean;
  is_agentic: boolean;
  is_ui_related: boolean;
  category: string;
  confidence: number;
  signals: SignalScores;
}

export interface SignalScores {
  keyword_score: number;       // -1 (trivial) to +1 (architectural)
  structural_score: number;    // 0 (simple text) to +1 (code-heavy, multi-file)
  intent_score: number;        // 0 (question/explore) to +1 (modify/create)
  scope_score: number;         // 0 (single item) to +1 (codebase-wide)
  reasoning_score: number;     // 0 (no reasoning) to +1 (deep reasoning)
  agentic_score: number;       // 0 (single-shot) to +1 (multi-step agentic)
  composite: number;           // Weighted combination
}

// ── Signal 1: Keyword Scoring ──────────────────────────────────────────

interface WeightedPattern {
  pattern: RegExp;
  weight: number; // negative = simpler, positive = more complex
}

const KEYWORD_PATTERNS: WeightedPattern[] = [
  // Trivial indicators (-0.8 to -0.5)
  { pattern: /fix\s*(a\s+)?typo/i, weight: -0.8 },
  { pattern: /update\s*(a\s+)?comment/i, weight: -0.8 },
  { pattern: /bump\s+version/i, weight: -0.7 },
  { pattern: /update\s+version/i, weight: -0.7 },
  { pattern: /remove\s+(unused|dead)\s+code/i, weight: -0.6 },
  { pattern: /add\s+(a\s+)?log/i, weight: -0.6 },
  { pattern: /rename\s+\w+/i, weight: -0.5 },
  { pattern: /change\s+\w+\s+to\s+\w+/i, weight: -0.5 },
  { pattern: /fix\s+(the\s+)?import/i, weight: -0.5 },
  { pattern: /add\s+a\s+comment/i, weight: -0.7 },
  { pattern: /format\s+(the\s+)?code/i, weight: -0.6 },
  { pattern: /delete\s+(this|the)\s+(file|line)/i, weight: -0.6 },

  // Simple indicators (-0.4 to -0.1)
  { pattern: /add\s+(a\s+)?(simple\s+)?function/i, weight: -0.3 },
  { pattern: /fix\s+(a\s+)?(small\s+)?bug/i, weight: -0.2 },
  { pattern: /update\s+(the\s+)?readme/i, weight: -0.3 },
  { pattern: /add\s+(a\s+)?test/i, weight: -0.2 },
  { pattern: /change\s+(the\s+)?default/i, weight: -0.3 },
  { pattern: /add\s+(an?\s+)?import/i, weight: -0.4 },
  { pattern: /update\s+depend/i, weight: -0.2 },
  { pattern: /fix\s+lint/i, weight: -0.3 },
  { pattern: /add\s+type\s+(annotation|hint)/i, weight: -0.3 },
  { pattern: /write\s+a\s+(unit\s+)?test/i, weight: -0.1 },

  // Moderate indicators (0.0 to 0.3)
  { pattern: /add\s+(a\s+)?(new\s+)?feature/i, weight: 0.2 },
  { pattern: /implement\s+\w+/i, weight: 0.2 },
  { pattern: /create\s+(a\s+)?(new\s+)?component/i, weight: 0.2 },
  { pattern: /add\s+(a\s+)?(new\s+)?endpoint/i, weight: 0.2 },
  { pattern: /refactor\s+\w+/i, weight: 0.15 },
  { pattern: /optimize\s+\w+/i, weight: 0.15 },
  { pattern: /add\s+error\s+handling/i, weight: 0.1 },
  { pattern: /add\s+validation/i, weight: 0.1 },
  { pattern: /add\s+(a\s+)?new\s+page/i, weight: 0.2 },
  { pattern: /create\s+(a\s+)?new\s+route/i, weight: 0.2 },
  { pattern: /add\s+pagination/i, weight: 0.15 },
  { pattern: /add\s+caching/i, weight: 0.2 },

  // Complex indicators (0.4 to 0.7)
  { pattern: /refactor\s+(the\s+)?(entire|whole|complete)/i, weight: 0.6 },
  { pattern: /redesign/i, weight: 0.5 },
  { pattern: /migrate/i, weight: 0.5 },
  { pattern: /add\s+authentication/i, weight: 0.5 },
  { pattern: /add\s+authorization/i, weight: 0.5 },
  { pattern: /integrate\s+\w+\s+with\s+\w+/i, weight: 0.5 },
  { pattern: /build\s+(a\s+)?(complete|full)/i, weight: 0.6 },
  { pattern: /debug\s+(a\s+)?complex/i, weight: 0.5 },
  { pattern: /fix\s+(a\s+)?race\s+condition/i, weight: 0.5 },
  { pattern: /memory\s+leak/i, weight: 0.5 },
  { pattern: /performance\s+(issue|problem|bottleneck)/i, weight: 0.4 },

  // Architectural indicators (0.8 to 1.0)
  { pattern: /architect/i, weight: 0.9 },
  { pattern: /design\s+(the\s+)?system/i, weight: 0.9 },
  { pattern: /plan\s+(the\s+)?implementation/i, weight: 0.8 },
  { pattern: /rewrite\s+(from\s+)?scratch/i, weight: 0.9 },
  { pattern: /convert\s+(the\s+)?(entire|whole)/i, weight: 0.8 },
  { pattern: /set\s+up\s+(the\s+)?infrastructure/i, weight: 0.8 },
  { pattern: /create\s+(a\s+)?(new\s+)?project\s+from/i, weight: 0.8 },
  { pattern: /design\s+(a\s+)?database\s+schema/i, weight: 0.8 },
  { pattern: /microservice/i, weight: 0.9 },
  { pattern: /monorepo/i, weight: 0.7 },
];

function computeKeywordScore(text: string): number {
  let totalWeight = 0;
  let matchCount = 0;

  for (const { pattern, weight } of KEYWORD_PATTERNS) {
    if (pattern.test(text)) {
      totalWeight += weight;
      matchCount++;
    }
  }

  if (matchCount === 0) return 0;
  return Math.max(-1, Math.min(1, totalWeight / matchCount));
}

// ── Signal 2: Structural Analysis ──────────────────────────────────────

function computeStructuralScore(text: string): number {
  let score = 0;

  // Code blocks present
  if (/```/.test(text)) score += 0.15;
  // Multiple code blocks
  if ((text.match(/```/g) ?? []).length > 2) score += 0.15;
  // File paths mentioned
  const filePathMatches = text.match(/[\w./\\-]+\.\w{1,10}/g) ?? [];
  score += Math.min(filePathMatches.length * 0.05, 0.3);
  // Line numbers
  if (/:\d+/.test(text)) score += 0.05;
  // Stack traces
  if (/at\s+\w+.*\(.*:\d+:\d+\)/.test(text)) score += 0.2;
  // Error messages
  if (/error|exception|stack\s*trace|traceback/i.test(text)) score += 0.1;
  // Long prompt (more context = more complex)
  const wordCount = text.split(/\s+/).length;
  if (wordCount > 100) score += 0.2;
  else if (wordCount > 50) score += 0.1;

  return Math.min(1, score);
}

// ── Signal 3: Intent Detection ─────────────────────────────────────────

function computeIntentScore(text: string): number {
  let score = 0.5; // neutral starting point

  // Questions pull toward exploration (lower score = simpler model ok)
  if (/^(what|how|why|when|where|who|can|does|is|are)\s/i.test(text)) score -= 0.2;
  if (/\?$/.test(text.trim())) score -= 0.1;
  if (/explain|describe|show\s+me|tell\s+me/i.test(text)) score -= 0.15;

  // Commands push toward modification (higher score = needs better model)
  if (/^(create|build|implement|add|write|make|generate|set\s*up)/i.test(text)) score += 0.2;
  if (/^(fix|debug|resolve|patch|repair)/i.test(text)) score += 0.1;
  if (/^(refactor|redesign|rewrite|migrate|convert)/i.test(text)) score += 0.25;
  if (/^(delete|remove|drop)/i.test(text)) score -= 0.1;

  return Math.max(0, Math.min(1, score));
}

// ── Signal 4: Scope Analysis ───────────────────────────────────────────

function computeScopeScore(text: string): number {
  let score = 0;

  // Multi-file indicators
  if (/across\s+(multiple|many|several|all)\s+(files|services?|microservices?|modules?|packages?|repos?|endpoints?)/i.test(text)) score += 0.4;
  if (/across\s+\d+\s+\w+/i.test(text)) score += 0.35;  // "across 15 microservices"
  if (/codebase/i.test(text)) score += 0.3;
  if (/project[-\s]wide/i.test(text)) score += 0.4;
  if (/system[-\s]wide/i.test(text)) score += 0.4;
  if (/everywhere|throughout/i.test(text)) score += 0.3;
  if (/all\s+(the\s+)?files/i.test(text)) score += 0.3;
  if (/every\s+(file|component|module|service)/i.test(text)) score += 0.3;
  if (/end[-\s]to[-\s]end/i.test(text)) score += 0.3;
  if (/full[-\s]stack/i.test(text)) score += 0.3;
  if (/\d+\s+(microservices?|services?|modules?|packages?|components?)/i.test(text)) score += 0.3;

  // Multiple file paths mentioned
  const filePaths = text.match(/[\w./\\-]+\.\w{1,10}/g) ?? [];
  if (filePaths.length > 3) score += 0.3;
  else if (filePaths.length > 1) score += 0.15;

  // Directory references
  if (/src\/|lib\/|app\/|components\//i.test(text)) score += 0.1;
  if ((text.match(/\//g) ?? []).length > 5) score += 0.1;

  return Math.min(1, score);
}

// ── Signal 5: Reasoning Detection ──────────────────────────────────────

function computeReasoningScore(text: string): number {
  let score = 0;

  if (/why\s+(does|is|do|are|did|was|were)/i.test(text)) score += 0.3;
  if (/explain|understand|analyze|evaluate/i.test(text)) score += 0.2;
  if (/compare|trade-?off|pros?\s+and\s+cons?/i.test(text)) score += 0.3;
  if (/debug|diagnose|investigate|root\s+cause/i.test(text)) score += 0.25;
  if (/review|audit|assess/i.test(text)) score += 0.2;
  if (/think\s+(about|through)|consider|weigh/i.test(text)) score += 0.25;
  if (/step\s+by\s+step|walk\s+me\s+through/i.test(text)) score += 0.2;
  if (/what\s+(would|should|could)\s+(happen|be|change)/i.test(text)) score += 0.15;
  if (/implications?|consequences?|impact/i.test(text)) score += 0.2;

  return Math.min(1, score);
}

// ── Signal 6: Agentic Detection (NadirClaw special) ────────────────────

function computeAgenticScore(text: string): number {
  let score = 0;

  // Tool use indicators
  if (/run\s+(the\s+)?(tests?|build|lint|ci)/i.test(text)) score += 0.2;
  if (/execute|deploy|publish|push/i.test(text)) score += 0.15;
  if (/install\s+\w+/i.test(text)) score += 0.1;

  // Multi-step indicators
  if (/then|after\s+that|next|finally|first.*then/i.test(text)) score += 0.25;
  if (/step\s*\d|phase\s*\d|1\.\s|2\.\s/i.test(text)) score += 0.3;

  // System prompt / agent indicators
  if (/you\s+are\s+(a|an)\s+\w+\s+(agent|assistant)/i.test(text)) score += 0.4;
  if (/tool_use|function_call|<tool>/i.test(text)) score += 0.5;
  if (/\bMCP\b|\bagent\b|\bpipeline\b/i.test(text)) score += 0.15;

  // Complex workflow indicators
  if (/and\s+(also|then|make\s+sure)/i.test(text)) score += 0.1;
  if (/including\s+\w+.*\s+and\s+/i.test(text)) score += 0.15;  // compound requirements
  if (/with\s+\w+.*,\s+\w+.*,\s+(and\s+)?\w+/i.test(text)) score += 0.15;  // "with X, Y, and Z"
  if (/\b(CI|CD|pipeline|workflow|automation)\b/i.test(text)) score += 0.2;

  return Math.min(1, score);
}

// ── UI / Visual Detection ─────────────────────────────────────────────

function detectUiRelated(text: string): boolean {
  // Direct UI/visual keywords
  const uiPatterns = [
    /\bui\b/i,
    /\bux\b/i,
    /\buser\s+interface/i,
    /\bfrontend\b/i,
    /\bfront[-\s]end\b/i,
    /\bcss\b/i,
    /\bstyl(e|ing)\b/i,
    /\blayout\b/i,
    /\bresponsive/i,
    /\banimation/i,
    /\btransition/i,
    /\bvisual/i,
    /\bdesign\s+(system|token|component)/i,
    /\btheme/i,
    /\bdark\s+mode/i,
    /\blight\s+mode/i,
    /\bcolor\s*(scheme|palette)?/i,
    /\bfont/i,
    /\btypography/i,
    /\bicon/i,
    /\bbutton/i,
    /\bmodal/i,
    /\bdialog/i,
    /\bdropdown/i,
    /\bmenu/i,
    /\bnavbar|navigation\s+bar/i,
    /\bsidebar/i,
    /\btooltip/i,
    /\btoast/i,
    /\bcard\s+component/i,
    /\bform\s+(field|input|element|validation|layout)/i,
    /\btable\s+(component|layout|row|column)/i,
    /\bgrid\s+(layout|system)/i,
    /\bflexbox/i,
    /\bpadding|margin|spacing/i,
    /\bborder[\s-]radius/i,
    /\bz-?index/i,
    /\bviewport/i,
    /\bmobile\s+(view|layout|design)/i,
    /\bbreakpoint/i,
    /\bmedia\s+query/i,
    /\bpixel/i,
    /\bscreenshot/i,
    /\brender/i,
    /\bcomponent\s+(style|look|appearance)/i,
    /\bSwiftUI\b/i,
    /\bAppKit\b/i,
    /\bUIKit\b/i,
    /\bReact\s+(component|hook|context|state)/i,
    /\bVue\s+component/i,
    /\bHTML\b/i,
    /\bSVG\b/i,
    /\bCanvas\b/i,
    /\bDOM\b/i,
    /\baccessibility|a11y/i,
    /\bscreen\s+reader/i,
    /\bARIA\b/i,
    /\btailwind/i,
    /\bshadcn/i,
    /\bMUI\b/i,
    /\bmaterial\s+design/i,
    /\bchakra/i,
    /\bbootstrap/i,
    /\bstyled[-\s]component/i,
    /\bemotion/i,
    /\bcss[-\s]module/i,
    /\bsass|scss|less\b/i,
    /\bcomputer[-\s]use/i,
    /\bclick\s+(the|a|on)/i,
    /\bscroll/i,
    /\bhover/i,
    /\bweb\s+page/i,
    /\bwebsite/i,
    /\blanding\s+page/i,
    /\bdashboard/i,
  ];

  return uiPatterns.some((p) => p.test(text));
}

// ── Composite Scoring ──────────────────────────────────────────────────

const SIGNAL_WEIGHTS = {
  keyword: 0.30,
  structural: 0.10,
  intent: 0.15,
  scope: 0.20,
  reasoning: 0.10,
  agentic: 0.15,
};

function computeComposite(scores: Omit<SignalScores, "composite">): number {
  // Normalize keyword_score from [-1, 1] to [0, 1]
  const normalizedKeyword = (scores.keyword_score + 1) / 2;

  return (
    normalizedKeyword * SIGNAL_WEIGHTS.keyword +
    scores.structural_score * SIGNAL_WEIGHTS.structural +
    scores.intent_score * SIGNAL_WEIGHTS.intent +
    scores.scope_score * SIGNAL_WEIGHTS.scope +
    scores.reasoning_score * SIGNAL_WEIGHTS.reasoning +
    scores.agentic_score * SIGNAL_WEIGHTS.agentic
  );
}

function compositeToComplexity(composite: number): { complexity: Complexity; confidence: number } {
  // Map [0, 1] composite to complexity tiers with confidence
  if (composite < 0.15) return { complexity: "trivial", confidence: 0.85 - composite };
  if (composite < 0.30) return { complexity: "simple", confidence: 0.75 };
  if (composite < 0.50) return { complexity: "moderate", confidence: 0.70 };
  if (composite < 0.70) return { complexity: "complex", confidence: 0.75 };
  return { complexity: "architectural", confidence: 0.80 };
}

function estimateTokens(complexity: Complexity): number {
  const estimates: Record<Complexity, number> = {
    trivial: 500,
    simple: 2000,
    moderate: 8000,
    complex: 25000,
    architectural: 50000,
  };
  return estimates[complexity];
}

function categorize(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("test")) return "testing";
  if (lower.includes("doc") || lower.includes("readme")) return "documentation";
  if (lower.includes("bug") || lower.includes("fix") || lower.includes("debug")) return "bugfix";
  if (lower.includes("refactor")) return "refactoring";
  if (lower.includes("feature") || lower.includes("add") || lower.includes("implement")) return "feature";
  if (lower.includes("performance") || lower.includes("optimize")) return "optimization";
  if (lower.includes("security") || lower.includes("auth")) return "security";
  if (lower.includes("deploy") || lower.includes("ci") || lower.includes("infra")) return "devops";
  if (lower.includes("style") || lower.includes("css") || lower.includes("ui")) return "ui";
  if (lower.includes("api") || lower.includes("endpoint")) return "api";
  if (lower.includes("database") || lower.includes("schema") || lower.includes("migration")) return "database";
  return "general";
}

export function classifyTask(description: string): TaskClassification {
  const keyword_score = computeKeywordScore(description);
  const structural_score = computeStructuralScore(description);
  const intent_score = computeIntentScore(description);
  const scope_score = computeScopeScore(description);
  const reasoning_score = computeReasoningScore(description);
  const agentic_score = computeAgenticScore(description);

  const partialScores = {
    keyword_score,
    structural_score,
    intent_score,
    scope_score,
    reasoning_score,
    agentic_score,
  };

  const composite = computeComposite(partialScores);
  const { complexity, confidence } = compositeToComplexity(composite);

  const signals: SignalScores = { ...partialScores, composite };

  return {
    complexity,
    estimated_tokens: estimateTokens(complexity),
    requires_multi_file: scope_score > 0.2,
    requires_reasoning: reasoning_score > 0.2,
    is_agentic: agentic_score > 0.3,
    is_ui_related: detectUiRelated(description),
    category: categorize(description),
    confidence,
    signals,
  };
}
