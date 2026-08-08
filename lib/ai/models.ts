export const AVAILABLE_MODELS = [
  { id: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5 (快，便宜)" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5 (推荐，均衡)" },
  { id: "anthropic/claude-opus-5", label: "Claude Opus 5 (最强，贵)" },
] as const;

export type AiModelId = (typeof AVAILABLE_MODELS)[number]["id"];

export const DEFAULT_OUTLINE_MODEL: AiModelId = "anthropic/claude-haiku-4-5";
export const DEFAULT_CONTENT_MODEL: AiModelId = "anthropic/claude-sonnet-5";
