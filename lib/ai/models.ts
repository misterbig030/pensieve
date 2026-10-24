// pricing is USD per 1M tokens, from the AI Gateway model catalog (https://ai-gateway.vercel.sh/v1/models)
export const AVAILABLE_MODELS = [
  // Anthropic
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5（Anthropic，便宜）", pricing: { input: 1, output: 5 } },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5（Anthropic，均衡）", pricing: { input: 2, output: 10 } },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5（Anthropic，推荐，均衡，更快）", pricing: { input: 2, output: 10 } },
  { id: "anthropic/claude-opus-5", label: "Claude Opus 5（Anthropic）", pricing: { input: 5, output: 25 } },
  { id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5（Anthropic，最强）", pricing: { input: 4, output: 20 } },
  // Google
  { id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite（Google，便宜）", pricing: { input: 0.25, output: 1.5 } },
  { id: "google/gemini-3-flash", label: "Gemini 3 Flash（Google，均衡）", pricing: { input: 0.5, output: 3 } },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro（Google，最强）", pricing: { input: 2, output: 12 } },
  // OpenAI
  { id: "openai/gpt-5.4-nano", label: "GPT-5.4 Nano（OpenAI，便宜）", pricing: { input: 0.2, output: 1.25 } },
  { id: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini（OpenAI，均衡）", pricing: { input: 0.75, output: 4.5 } },
  { id: "openai/gpt-5.4", label: "GPT-5.4（OpenAI，最强）", pricing: { input: 2.5, output: 15 } },
] as const;

export type AiModelId = (typeof AVAILABLE_MODELS)[number]["id"];

/** The providers the model list knows, as the prefix of each model id ("anthropic/claude-sonnet-5.5"). */
export const MODEL_PROVIDERS = ["anthropic", "google", "openai"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** The provider a gateway model id belongs to: the part before the slash. */
export function providerOf(id: AiModelId): ModelProvider {
  return id.split("/")[0] as ModelProvider;
}

/** Who paid for a model call: the app's gateway key, or the user's own key. */
export const KEY_OWNERS = ["app", "user"] as const;
export type KeyOwner = (typeof KEY_OWNERS)[number];

/** Why a user's key was refused, as stored on its row and shown on the settings page. */
export const KEY_ERRORS = ["invalid", "credits", "rate_limit", "other"] as const;
export type KeyErrorKind = (typeof KEY_ERRORS)[number];

/** The outline drafts the weeks and the days, and revises the plan: it decides where each reservation goes. */
export const DEFAULT_OUTLINE_MODEL: AiModelId = "anthropic/claude-opus-5.5";
export const DEFAULT_CONTENT_MODEL: AiModelId = "anthropic/claude-sonnet-5";
/** Chat turns are short and latency-sensitive; the revision tool uses the outline model. */
export const DEFAULT_CHAT_MODEL: AiModelId = "anthropic/claude-haiku-4.5";
/** Research judges which sources agree, which needs more than the outline model. Arm C in the eval uses the same. */
export const DEFAULT_RESEARCH_MODEL: AiModelId = "anthropic/claude-sonnet-5.5";
/** The allocation call, after research: it chooses each material's part and the plan's time split. */
export const DEFAULT_ALLOCATE_MODEL: AiModelId = "anthropic/claude-opus-5.5";

/** Anthropic's reasoning effort levels; the default when none is sent is `high` on Sonnet. */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
/**
 * The research loops (arm A's loop, arm W's workers, arm C's loop) run at this effort. Measured on 2026-10-14
 * (`evals/research/effort-bench.ts`, Sonnet 5.5, one brief): at `low` the workers used 2 of 12 reads and declared the
 * backbone from search snippets; at `medium` 6; at `high` all 12, with the backbone's notes written and the gate keeping
 * 9 of 10. Effort changes how much work the loop does, not only how long it thinks.
 */
export const RESEARCH_LOOP_EFFORT: ReasoningEffort = "high";
/**
 * The candidate step runs at this effort. Measured on 2026-10-13 (`evals/research/candidates-bench.ts`): given the same
 * notes, Sonnet 5.5 at `low` wrote no reasoning tokens and chose in 8 s the list it chose in 25 s at `high`; Sonnet 5 at
 * its default effort took 94 s on the same prompt.
 */
export const CANDIDATE_STEP_EFFORT: ReasoningEffort = "low";
/**
 * The allocation runs at this effort: it makes the plan's real choices (the backbone, each material's part, what is
 * dropped, the practice shares and the plan's coverage) over research's whole, unselected list.
 */
export const ALLOCATE_EFFORT: ReasoningEffort = "high";
/** The outline and revision calls run at this effort: placing the reservations across the weeks is a judgment call too. */
export const OUTLINE_EFFORT: ReasoningEffort = "high";

interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** Estimates the USD cost of a generation from its token usage and the model's list price. */
export function estimateCostUsd(modelId: AiModelId, usage: TokenUsage): number {
  const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
  if (!model) return 0;
  const inputCost = ((usage.inputTokens ?? 0) / 1_000_000) * model.pricing.input;
  const outputCost = ((usage.outputTokens ?? 0) / 1_000_000) * model.pricing.output;
  return inputCost + outputCost;
}
