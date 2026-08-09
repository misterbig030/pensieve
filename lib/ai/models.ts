// pricing is USD per 1M tokens, from the AI Gateway model catalog (https://ai-gateway.vercel.sh/v1/models)
export const AVAILABLE_MODELS = [
  // Anthropic
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5（Anthropic，便宜）", pricing: { input: 1, output: 5 } },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5（Anthropic，推荐，均衡）", pricing: { input: 2, output: 10 } },
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
