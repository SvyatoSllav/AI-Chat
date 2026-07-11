import { EffortId } from "./effort";

// "auto" routes cheap⇄flagship by the request; any other value is an explicit
// GLM model id the user pinned from the selector.
export type ModelChoice = string; // "auto" | GLM model id
export type ModelTier = "fast" | "smart";

// Models available on the GLM (Z.ai) Lite coding plan, offered in the selector.
export interface ModelInfo {
  id: string;
  label: string;
  note: string;
  reasoning: boolean;
}
export const LITE_MODELS: ModelInfo[] = [
  { id: "glm-5.2", label: "GLM-5.2", note: "flagship reasoning", reasoning: true },
  { id: "glm-4.7", label: "GLM-4.7", note: "strong, balanced", reasoning: true },
  { id: "glm-4.6", label: "GLM-4.6", note: "solid all-rounder", reasoning: true },
  { id: "glm-4.5-air", label: "GLM-4.5-Air", note: "fast & economical", reasoning: false },
  { id: "glm-5-turbo", label: "GLM-5-Turbo", note: "fastest", reasoning: false },
];
export const MODEL_BY_ID: Record<string, ModelInfo> = Object.fromEntries(LITE_MODELS.map((m) => [m.id, m]));

// Which concrete model each auto tier maps to.
const TIER_MODEL: Record<ModelTier, string> = { fast: "glm-4.5-air", smart: "glm-5.2" };

// Signals that a request needs the flagship: research/synthesis/multi-note work.
const HARD_RE = /\b(research|synthesi[sz]|summari[sz]|compare|contrast|reorgani[sz]|refactor|rewrite|restructure|analy[sz]e|outline|across|every note|all (my|the|your) notes|contradict|\bmoc\b|map of content|consolidat|merge|audit|cross-?reference)\b/i;

export interface Routed {
  model: string; // GLM model id sent to the backend
  label: string; // for the badge
  reason: string;
}

/**
 * Resolve the model to use. A pinned model id wins; "auto" routes to a cheap
 * model for simple tasks and the flagship for hard ones, so a research turn
 * gets the strong model without draining quota on simple ones.
 */
export function chooseModel(text: string, effort: EffortId, pinned: ModelChoice): Routed {
  if (pinned && pinned !== "auto" && MODEL_BY_ID[pinned]) {
    return { model: pinned, label: MODEL_BY_ID[pinned].label, reason: "pinned" };
  }
  let tier: ModelTier;
  let reason: string;
  if (effort === "ultra" || effort === "high") { tier = "smart"; reason = `${effort} effort`; }
  else if (effort === "low") { tier = "fast"; reason = "low effort"; }
  else if (HARD_RE.test(text) || text.length > 260) { tier = "smart"; reason = "complex task"; }
  else { tier = "fast"; reason = "simple task"; }
  const model = TIER_MODEL[tier];
  return { model, label: MODEL_BY_ID[model].label, reason };
}

export function modelLabel(choice: ModelChoice): string {
  if (!choice || choice === "auto") return "Auto";
  return MODEL_BY_ID[choice]?.label ?? choice;
}
