export const AVAILABLE_MODELS = [
  // Anthropic
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5（Anthropic，便宜）" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5（Anthropic，推荐，均衡）" },
  { id: "anthropic/claude-opus-5", label: "Claude Opus 5（Anthropic，最强）" },
  // Google
  { id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite（Google，便宜）" },
  { id: "google/gemini-3-flash", label: "Gemini 3 Flash（Google，均衡）" },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro（Google，最强）" },
  // OpenAI
  { id: "openai/gpt-5.4-nano", label: "GPT-5.4 Nano（OpenAI，便宜）" },
  { id: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini（OpenAI，均衡）" },
  { id: "openai/gpt-5.4", label: "GPT-5.4（OpenAI，最强）" },
] as const;

export type AiModelId = (typeof AVAILABLE_MODELS)[number]["id"];

export const DEFAULT_OUTLINE_MODEL: AiModelId = "anthropic/claude-haiku-4.5";
export const DEFAULT_CONTENT_MODEL: AiModelId = "anthropic/claude-sonnet-5";
