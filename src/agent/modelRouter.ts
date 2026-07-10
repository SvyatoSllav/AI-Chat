import { EffortId } from "./effort";

export type ModelChoice = "auto" | "fast" | "smart";
export type ModelTier = "fast" | "smart";

export const MODELS: Record<ModelTier, { label: string; note: string }> = {
  fast: { label: "GLM-4.5-air", note: "fast & economical" },
  smart: { label: "GLM-5.2", note: "flagship reasoning" },
};

// Signals that a request needs the flagship: research/synthesis/multi-note work.
const HARD_RE = /\b(research|synthesi[sz]|summari[sz]|compare|contrast|reorgani[sz]|refactor|rewrite|restructure|analy[sz]e|outline|across|every note|all (my|the|your) notes|contradict|\bmoc\b|map of content|consolidat|merge|audit|cross-?reference)\b/i;

export interface Routed {
  tier: ModelTier;
  reason: string;
}

/**
 * Smart model choice. `pinned` (from /model or the header) wins; otherwise we
 * default to the cheap model and escalate to the flagship for hard tasks so a
 * research turn gets the strong model without draining quota on simple ones.
 */
export function chooseModel(text: string, effort: EffortId, pinned: ModelChoice): Routed {
  if (pinned === "fast") return { tier: "fast", reason: "pinned" };
  if (pinned === "smart") return { tier: "smart", reason: "pinned" };

  if (effort === "ultra" || effort === "high") return { tier: "smart", reason: `${effort} effort` };
  if (effort === "low") return { tier: "fast", reason: "low effort" };

  // medium: decide from the request itself
  if (HARD_RE.test(text) || text.length > 260) return { tier: "smart", reason: "complex task" };
  return { tier: "fast", reason: "simple task" };
}
