export type EffortId = "low" | "medium" | "high" | "ultra";

export interface EffortProfile {
  id: EffortId;
  label: string;
  hint: string;
  topK: number;
  maxSteps: number;
  /** Which hosted model tier to use. "fast" = cheap/economical (GLM-4.5-air-
   *  class), spends far less of the subscription quota; "smart" = flagship
   *  (GLM-5.2). The backend maps these names to concrete models. */
  modelTier: "fast" | "smart";
  /** Extra system-prompt directives; empty for the default behaviour. */
  directive: string;
}

export const EFFORTS: Record<EffortId, EffortProfile> = {
  low: {
    id: "low",
    label: "Low",
    hint: "Fastest & cheapest — economical model, saves your quota",
    topK: 4,
    maxSteps: 6,
    modelTier: "fast",
    directive: "Be fast and economical: minimum tool calls, short answers. Don't explore beyond what's asked.",
  },
  medium: {
    id: "medium",
    label: "Medium",
    hint: "Balanced default",
    topK: 8,
    maxSteps: 12,
    modelTier: "smart",
    directive: "",
  },
  high: {
    id: "high",
    label: "High",
    hint: "Thorough — reads more notes before acting",
    topK: 12,
    maxSteps: 20,
    modelTier: "smart",
    directive:
      "Be thorough: search with more than one phrasing, read every note that looks relevant before drawing conclusions or editing, and double-check paths before writing.",
  },
  ultra: {
    id: "ultra",
    label: "Ultra",
    hint: "Research mode — plans, explores broadly, reads deeply, cross-checks",
    topK: 20,
    maxSteps: 30,
    modelTier: "smart",
    directive: [
      "ULTRA / RESEARCH MODE — Follow these steps strictly:",
      "1. PLAN: Before any tool call, write a one-paragraph internal plan listing what you will search for and which notes you expect to read.",
      "2. DISCOVER: Run at least 3 searches with different phrasings/synonyms. List the candidate notes.",
      "3. READ EVERYTHING: Call read_note on every candidate note — do not skip any, even ones that seem less important. You must open each file individually.",
      "4. CROSS-CHECK: After reading, note any contradictions or gaps between sources.",
      "5. ANSWER: Only now write your final answer, citing every note you opened with [[wikilinks]].",
      "HARD RULE: You are not allowed to mention, quote, or summarize a note unless you called read_note on it in this session. Zero exceptions.",
    ].join(" "),
  },
};

export const EFFORT_ORDER: EffortId[] = ["low", "medium", "high", "ultra"];
