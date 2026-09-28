import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { ToolLoopAgent, isStepCount, type LanguageModel } from "ai";
import { buildGenerationLogRow, emitGenerationLog, loggedGenerateObject } from "@/lib/ai/logged";
import { DEFAULT_RESEARCH_MODEL } from "@/lib/ai/models";
import {
  briefLines,
  buildFinalPrompt,
  buildResearchInstructions,
  type ArmInput,
  type ArmResult,
  type ResearchArm,
  type StopReason,
} from "@/lib/ai/research/agent";
import { RESEARCH_CAPS, ResearchNotes, type ResearchCaps, type SearchResult } from "@/lib/ai/research/tools";
import { candidateListSchema, type Candidate, type LearnerNote } from "@/lib/ai/research/verify";

/**
 * Arm C, eval only: the same Claude model with Anthropic's server-side `web_search` and `web_fetch` tools, prompted
 * to the same strategy and finishing with the same structured step. Everything after it (the gate, drafting, the
 * judges) is shared with arm A, so a difference in plan quality is caused by research alone.
 *
 * `route: "gateway"` sends the provider tools through the AI Gateway; `route: "direct"` calls Anthropic with
 * `ANTHROPIC_API_KEY`, for when the gateway does not pass provider-executed tools through. Nothing in the app imports
 * this file, so the app has no direct provider dependency.
 */

export interface ProviderArmOptions {
  route?: "gateway" | "direct";
  caps?: ResearchCaps;
  /** Tests pass a mock model. */
  model?: LanguageModel;
}

/** Arm C's extra cost: Anthropic bills server-side searches on top of tokens ($10 per 1,000 at the time of writing). */
export const WEB_SEARCH_USD = 0.01;

const TOOL_NAMES = { search: "web_search", fetch: "web_fetch" };

interface WebSearchHit {
  url?: string;
  title?: string | null;
  pageAge?: string | null;
}

interface WebFetchOutput {
  type?: string;
  url?: string;
  content?: { title?: string | null; source?: { type?: string; data?: string } };
  errorCode?: string;
}

export function createProviderArm(options: ProviderArmOptions = {}): ResearchArm {
  const caps = options.caps ?? RESEARCH_CAPS;
  const modelId = DEFAULT_RESEARCH_MODEL;
  const provider = options.route === "direct" ? createAnthropic() : anthropic;
  const model: LanguageModel = options.model ?? (options.route === "direct" ? provider(modelId.replace(/^anthropic\//, "")) : modelId);

  return async function research({ brief, signal, emit, log }: ArmInput): Promise<ArmResult> {
    const notes = new ResearchNotes();
    const loop = new AbortController();
    const clockTimer = setTimeout(() => loop.abort(new Error("clock")), caps.wallMs);
    const onOuterAbort = () => loop.abort(new Error("cancelled"));
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    let stoppedBy: StopReason = "model";
    let steps = 0;
    let searches = 0;
    let fetches = 0;
    let costUsd = 0;

    const instructions = buildResearchInstructions(caps, TOOL_NAMES);
    const prompt = briefLines(brief).join("\n");
    const agent = new ToolLoopAgent({
      model,
      instructions,
      tools: {
        web_search: provider.tools.webSearch_20260209({ maxUses: caps.searches }),
        web_fetch: provider.tools.webFetch_20260209({ maxUses: caps.fetches, maxContentTokens: 4000 }),
      },
      stopWhen: isStepCount(caps.steps),
      onStepEnd: async (step) => {
        steps += 1;
        if (step.text.trim()) notes.remarks.push(step.text.trim());
        const queries = new Map<string, string>();
        for (const part of step.content) {
          if (part.type === "tool-call") {
            const input = part.input as { query?: string; url?: string };
            if (part.toolName === "web_search" && input.query) queries.set(part.toolCallId, input.query);
          }
          if (part.type === "tool-result" && part.toolName === "web_search") {
            searches += 1;
            const hits = (Array.isArray(part.output) ? part.output : []) as WebSearchHit[];
            const results: SearchResult[] = hits
              .filter((h): h is WebSearchHit & { url: string } => typeof h.url === "string")
              .map((h) => ({ title: h.title ?? h.url, url: h.url, snippet: "", publishedDate: h.pageAge ?? null }));
            const query = queries.get(part.toolCallId) ?? (part.input as { query?: string })?.query ?? "";
            notes.searches.push({ query, results });
            emit({ type: "research.search", query, results: results.length });
          }
          if (part.type === "tool-result" && part.toolName === "web_fetch") {
            fetches += 1;
            const out = (part.output ?? {}) as WebFetchOutput;
            const url = out.url ?? (part.input as { url?: string })?.url ?? "";
            const ok = out.type === "web_fetch_result";
            const text = out.content?.source?.type === "text" ? (out.content.source.data ?? "") : "";
            notes.fetches.push({ url, ok, title: out.content?.title ?? null, finalUrl: ok ? url : null, reason: ok ? undefined : (out.errorCode ?? "error"), excerpt: text.slice(0, 400).replace(/\s+/g, " ") });
            emit({ type: "research.fetch", url, ok, ...(ok ? {} : { reason: out.errorCode ?? "error" }) });
          }
          if (part.type === "tool-error") {
            if (part.toolName === "web_fetch") fetches += 1;
            if (part.toolName === "web_search") searches += 1;
          }
        }
        const row = buildGenerationLogRow({
          caller: "research",
          model: modelId,
          usage: step.usage,
          latencyMs: Math.round(step.performance?.stepTimeMs ?? 0),
          trackId: log?.trackId,
          userId: log?.userId,
        });
        costUsd += row.costUsd;
        await emitGenerationLog(log?.onLog, row);
        log?.onCall?.({
          ...row,
          label: `Research C · step ${steps}`,
          system: steps === 1 ? instructions : null,
          prompt: steps === 1 ? prompt : `(step ${steps})`,
          response: [step.text, ...step.toolCalls.map((c) => `[tool call] ${c.toolName} ${JSON.stringify(c.input)}`)].filter(Boolean).join("\n\n"),
          finishReason: step.finishReason ?? null,
          facts: [`${searches} searches`, `${fetches} reads`],
        });
      },
    });

    try {
      await agent.generate({ prompt, abortSignal: loop.signal });
      if (steps >= caps.steps) stoppedBy = "steps";
    } catch (error) {
      if (!loop.signal.aborted) {
        // A provider error (for example the gateway refusing provider-executed tools) ends research like a search outage.
        console.error("[arm C] research loop failed", error);
        stoppedBy = "search-error";
      } else {
        const reason = loop.signal.reason instanceof Error ? loop.signal.reason.message : "";
        stoppedBy = reason === "clock" ? "clock" : "cancelled";
      }
    } finally {
      clearTimeout(clockTimer);
      signal?.removeEventListener("abort", onOuterAbort);
    }
    const searchesOk = notes.searches.length;

    let list: { candidates: Candidate[]; learner: LearnerNote[] } = { candidates: [], learner: [] };
    if (stoppedBy !== "cancelled") {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const { object, costUsd: cost } = await loggedGenerateObject(
            {
              model: modelId,
              languageModel: typeof model === "string" ? undefined : model,
              schema: candidateListSchema,
              prompt: buildFinalPrompt(brief, notes.render()),
              label: attempt === 1 ? "Research C · candidates" : "Research C · candidates (retry)",
              abortSignal: signal,
            },
            { ...log, caller: "research" },
          );
          costUsd += cost;
          list = object;
          break;
        } catch (error) {
          if (signal?.aborted) break;
          console.error(`[arm C] candidate step failed (attempt ${attempt})`, error);
        }
      }
    }

    return {
      candidates: list.candidates,
      learnerNotes: list.learner,
      seenUrls: notes.seenUrls(),
      counts: { steps, searches, fetches },
      searchesOk,
      stoppedBy,
      costUsd: costUsd + searches * WEB_SEARCH_USD,
    };
  };
}
