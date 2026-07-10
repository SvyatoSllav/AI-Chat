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
    hint: "Research mode — plans, explores broadly, cross-checks",
    topK: 20,
    maxSteps: 30,
    modelTier: "smart",
    directive: [
      "Research mode. Start by writing a brief plan of what you will look for.",
      "Explore broadly: run several searches with different phrasings and synonyms, follow [[wikilinks]] and backlinks you encounter, and read all plausibly relevant notes.",
      "Cross-check claims across notes and point out contradictions.",
      "Only then act or answer — comprehensively, with citations to every note you used.",
    ].join(" "),
  },
};

export const EFFORT_ORDER: EffortId[] = ["low", "medium", "high", "ultra"];
