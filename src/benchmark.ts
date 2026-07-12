/**
 * In-plugin benchmark runner.
 *
 * Reads scenarios and model configs from the vault, runs each scenario
 * through the real agent tool loop (search_vault + read_note), and writes
 * a structured results note to benchmarks/results/.
 *
 * Vault files expected:
 *   benchmarks/scenarios.json  – scenario definitions
 *   benchmarks/models.json     – list of {label, model} or {label, baseUrl, apiKey, model}
 */

import { App, Notice, TFile } from "obsidian";
import type { VaultIndex } from "./rag/indexer";
import { runAgent, agentSystemPrompt, AgentStep } from "./agent/agent";
import { HostedProvider } from "./providers/hosted";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible";
import type { LLMProvider, ChatMessage } from "./providers/types";
import type { AIChatSettings } from "./settings";

// ── Config types ──────────────────────────────────────────────────────────────

interface ModelConfig {
  label: string;
  /** Explicit GLM model name (e.g. "glm-4.5-air", "glm-4.6", "glm-4.7").
   *  Sent to the backend; KNOWN_MODELS list lets Pro users specify it directly. */
  model: string;
  /** Optional: bypass the hosted backend and talk directly to any OpenAI-compat API */
  baseUrl?: string;
  apiKey?: string;
}

interface EvalSpec {
  must_contain: string[];
  nice_to_contain?: string[];
  must_cite_notes?: string[];
  min_notes_read?: number;
}

interface Scenario {
  id: string;
  type: string;
  name: string;
  prompt: string;
  eval: EvalSpec;
}

interface ScenarioResult {
  id: string;
  name: string;
  type: string;
  answer: string;
  notesRead: string[];    // paths from read_note calls
  searchQueries: string[]; // queries from search_vault calls
  toolCallCount: number;
  latencyMs: number;
  scores: Scores;
  passed: boolean;
}

interface Scores {
  must_score: number;
  nice_score: number;
  citation_score: number;
  note_coverage: number;
  overall: number;
  // detail
  must_hits: string[];
  nice_hits: string[];
  citation_hits: string[];
}

// ── Evaluator ─────────────────────────────────────────────────────────────────

function evaluate(answer: string, notesRead: string[], spec: EvalSpec): Scores {
  const lower = answer.toLowerCase();

  const must_hits = spec.must_contain.filter((p) => lower.includes(p.toLowerCase()));
  const must_score = spec.must_contain.length ? must_hits.length / spec.must_contain.length : 1;

  const niceItems = spec.nice_to_contain ?? [];
  const nice_hits = niceItems.filter((p) => lower.includes(p.toLowerCase()));
  const nice_score = niceItems.length ? nice_hits.length / niceItems.length : 1;

  const citeItems = spec.must_cite_notes ?? [];
  const citation_hits = citeItems.filter((n) => lower.includes(n.toLowerCase()));
  const citation_score = citeItems.length ? citation_hits.length / citeItems.length : 1;

  // How many relevant notes did it actually read?
  const minReads = spec.min_notes_read ?? 1;
  const note_coverage = Math.min(notesRead.length / minReads, 1);

  // Weighted overall: correctness first, then richness
  const overall = must_score * 0.50 + nice_score * 0.15 + citation_score * 0.20 + note_coverage * 0.15;

  return { must_score, nice_score, citation_score, note_coverage, overall, must_hits, nice_hits, citation_hits };
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runBenchmark(app: App, index: VaultIndex, settings: AIChatSettings): Promise<void> {
  // Read scenarios
  const scenariosFile = app.vault.getAbstractFileByPath("benchmarks/scenarios.json");
  if (!(scenariosFile instanceof TFile)) {
    new Notice("benchmarks/scenarios.json not found in vault. Create it first.", 8000);
    return;
  }
  const { scenarios } = JSON.parse(await app.vault.read(scenariosFile)) as { scenarios: Scenario[] };

  // Read model configs
  const modelsFile = app.vault.getAbstractFileByPath("benchmarks/models.json");
  if (!(modelsFile instanceof TFile)) {
    new Notice("benchmarks/models.json not found in vault. Create it first.", 8000);
    return;
  }
  const models = JSON.parse(await app.vault.read(modelsFile)) as ModelConfig[];

  if (!models.length || !scenarios.length) {
    new Notice("models.json or scenarios.json is empty.");
    return;
  }

  new Notice(`Benchmark starting: ${scenarios.length} scenarios × ${models.length} models…`);

  const allResults: Record<string, ScenarioResult[]> = {};

  for (const mc of models) {
    let provider: LLMProvider;
    if (mc.baseUrl && mc.apiKey) {
      provider = new OpenAICompatibleProvider(mc.baseUrl, mc.apiKey, mc.model);
    } else {
      // Use the hosted backend (auth from plugin settings); pass model name explicitly
      if (!settings.authToken) {
        new Notice(`[${mc.label}] No auth token — sign in first. Skipping.`);
        continue;
      }
      provider = new HostedProvider(settings.backendUrl, settings.authToken);
    }

    const results: ScenarioResult[] = [];

    for (const sc of scenarios) {
      const t0 = Date.now();
      const notesRead: string[] = [];
      const searchQueries: string[] = [];
      let toolCallCount = 0;

      const messages: ChatMessage[] = [
        { role: "system", content: agentSystemPrompt(undefined, "") },
        { role: "user", content: sc.prompt },
      ];

      let answer = "";
      try {
        answer = await runAgent(provider, app, index, messages, {
          autoApprove: false,
          maxSteps: 20,
          model: mc.model,
        }, {
          onText: () => {},
          onStep: (step: AgentStep) => {
            toolCallCount++;
            if (step.name === "read_note" && step.args?.path) {
              notesRead.push(step.args.path as string);
            }
            if (step.name === "search_vault" && step.args?.query) {
              searchQueries.push(step.args.query as string);
            }
          },
          confirmWrite: async () => false, // never write during benchmark
        });
      } catch (err: unknown) {
        answer = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }

      const latencyMs = Date.now() - t0;
      const scores = evaluate(answer, notesRead, sc.eval);

      results.push({
        id: sc.id,
        name: sc.name,
        type: sc.type,
        answer,
        notesRead,
        searchQueries,
        toolCallCount,
        latencyMs,
        scores,
        passed: scores.must_score === 1,
      });

      // Brief status update
      const pct = (scores.overall * 100).toFixed(0);
      const status = scores.must_score === 1 ? "✅" : "❌";
      new Notice(`${mc.label} · ${sc.id} ${status} ${pct}%`, 2000);
    }

    allResults[mc.label] = results;
  }

  // Write results note
  const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
  const noteContent = buildResultNote(ts, models, scenarios, allResults);
  const folderPath = "benchmarks/results";
  if (!app.vault.getAbstractFileByPath(folderPath)) {
    await app.vault.createFolder(folderPath);
  }
  const fname = `${folderPath}/${new Date().toISOString().slice(0, 16).replace(":", "-")}.md`;
  const outFile = await app.vault.create(fname, noteContent);
  await app.workspace.getLeaf(false).openFile(outFile);

  // Also write a JSON dump alongside for future analysis
  const jsonFname = fname.replace(".md", ".json");
  await app.vault.create(jsonFname, JSON.stringify({ ts, models, results: allResults }, null, 2));

  new Notice(`✅ Benchmark done! Results → ${fname}`, 8000);
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildResultNote(
  ts: string,
  models: ModelConfig[],
  scenarios: Scenario[],
  results: Record<string, ScenarioResult[]>,
): string {
  const L: string[] = [];

  L.push(`# Benchmark Results — ${ts}`, "");
  L.push(`**Models**: ${models.map((m) => m.label).join(" · ")}  `);
  L.push(`**Scenarios**: ${scenarios.length}`, "");

  // ── Summary table ──────────────────────────────────────────────────────────
  L.push("## Summary", "");
  L.push("| Model | Passed | Overall | Notes/Q | Tool Calls | Latency |");
  L.push("|-------|--------|---------|---------|------------|---------|");
  for (const [label, rs] of Object.entries(results)) {
    const passed  = rs.filter((r) => r.passed).length;
    const avg     = avg100(rs, (r) => r.scores.overall);
    const notes   = avgF1(rs, (r) => r.notesRead.length);
    const tools   = avgF1(rs, (r) => r.toolCallCount);
    const latency = avgF1(rs, (r) => r.latencyMs / 1000);
    L.push(`| **${label}** | ${passed}/${rs.length} | ${avg}% | ${notes} | ${tools} | ${latency}s |`);
  }
  L.push("");

  // ── Per-type breakdown ─────────────────────────────────────────────────────
  const types = [...new Set(scenarios.map((s) => s.type))];
  L.push("## By Scenario Type", "");
  L.push("| Type | " + Object.keys(results).map((l) => l).join(" | ") + " |");
  L.push("|------|" + Object.keys(results).map(() => "---").join("|") + "|");
  for (const t of types) {
    const row = Object.values(results).map((rs) => {
      const sub = rs.filter((r) => r.type === t);
      return sub.length ? `${avg100(sub, (r) => r.scores.overall)}%` : "—";
    });
    L.push(`| ${t} | ${row.join(" | ")} |`);
  }
  L.push("");

  // ── Per-scenario detail ────────────────────────────────────────────────────
  L.push("## Scenario Detail", "");
  for (const sc of scenarios) {
    L.push(`### ${sc.id} · ${sc.name}`, "");
    L.push(`> *${sc.prompt}*`, "");
    L.push("");

    // Comparison table
    L.push("| Model | Score | Must | Notes read | Searches | Latency |");
    L.push("|-------|-------|------|------------|----------|---------|");
    for (const [label, rs] of Object.entries(results)) {
      const r = rs.find((x) => x.id === sc.id);
      if (!r) continue;
      const pct    = (r.scores.overall * 100).toFixed(0);
      const must   = `${r.scores.must_hits.length}/${sc.eval.must_contain.length}`;
      const status = r.passed ? "✅" : "❌";
      const rNotes = r.notesRead.map((p) => p.split("/").pop()?.replace(".md", "")).join(", ") || "—";
      const searches = r.searchQueries.join(", ") || "—";
      L.push(`| ${label} | ${status} ${pct}% | ${must} | ${rNotes} | ${searches} | ${(r.latencyMs / 1000).toFixed(1)}s |`);
    }
    L.push("");

    // Answer snippets in collapsibles
    for (const [label, rs] of Object.entries(results)) {
      const r = rs.find((x) => x.id === sc.id);
      if (!r) continue;
      const snippet = r.answer.slice(0, 600) + (r.answer.length > 600 ? "\n…[truncated]" : "");
      L.push(`<details><summary>${label}</summary>`, "");
      L.push("```");
      L.push(snippet);
      L.push("```");
      if (r.scores.must_hits.length < sc.eval.must_contain.length) {
        const missed = sc.eval.must_contain.filter((p) => !r.scores.must_hits.includes(p));
        L.push("");
        L.push(`⚠️ Missed: ${missed.map((m) => `\`${m}\``).join(", ")}`);
      }
      L.push("</details>", "");
    }
  }

  return L.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function avg100(arr: ScenarioResult[], fn: (r: ScenarioResult) => number): string {
  return arr.length ? (arr.reduce((s, r) => s + fn(r), 0) / arr.length * 100).toFixed(1) : "—";
}

function avgF1(arr: ScenarioResult[], fn: (r: ScenarioResult) => number): string {
  return arr.length ? (arr.reduce((s, r) => s + fn(r), 0) / arr.length).toFixed(1) : "—";
}
