// pricing is USD per 1M tokens, from the AI Gateway model catalog (https://ai-gateway.vercel.sh/v1/models)
export const AVAILABLE_MODELS = [
  // Anthropic
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5（Anthropic，便宜）", pricing: { input: 1, output: 5 } },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5（Anthropic，均衡）", pricing: { input: 2, output: 10 } },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5（Anthropic，推荐，均衡，更快）", pricing: { input: 2, output: 10 } },
  { id: "anthropic/claude-opus-5", label: "Claude Opus 5（Anthropic，最强）", pricing: { input: 5, output: 25 } },
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

export const DEFAULT_OUTLINE_MODEL: AiModelId = "anthropic/claude-haiku-4.5";
export const DEFAULT_CONTENT_MODEL: AiModelId = "anthropic/claude-sonnet-5";
/** Research judges which sources agree, which needs more than the outline model. Arm C in the eval uses the same. */
export const DEFAULT_RESEARCH_MODEL: AiModelId = "anthropic/claude-sonnet-5.5";

/** Anthropic's reasoning effort levels; the default when none is sent is `high` on Sonnet. */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
/**
 * Every research call runs at this effort. Measured on 2026-10-13 (`evals/research/candidates-bench.ts`): Sonnet 5 at its
 * default effort spent 94 s and 7,800 reasoning tokens on the candidate step; Sonnet 5.5 at `low` wrote no reasoning
 * tokens, took 10 s and chose the same list. The worker steps showed the same pattern (19 s to issue two searches).
 */
export const RESEARCH_EFFORT: ReasoningEffort = "low";

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
