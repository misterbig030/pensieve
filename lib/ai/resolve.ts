/**
 * Which model object each role uses for one request: the gateway id string paid by the app, or a direct instance built
 * from the user's own key and paid by them. Resolved once per request, right after auth(), and passed down explicitly.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { getUserApiKeys } from "@/lib/db/userApiKeys";
import { openSecret } from "@/lib/secrets";
import { DEFAULT_ALLOCATE_MODEL, DEFAULT_CHAT_MODEL, DEFAULT_CONTENT_MODEL, DEFAULT_OUTLINE_MODEL, DEFAULT_RESEARCH_MODEL, providerOf, type AiModelId, type KeyOwner, type ModelProvider } from "./models";

export interface ResolvedModel {
  /** The gateway id string, or a direct instance built from the user's key. */
  model: AiModelId | LanguageModel;
  /** Always the gateway-style id, for logging and pricing. */
  id: AiModelId;
  keyOwner: KeyOwner;
}

export interface ModelSet {
  outline: ResolvedModel;
  content: ResolvedModel;
  chat: ResolvedModel;
  research: ResolvedModel;
  allocate: ResolvedModel;
}
export type ModelRole = keyof ModelSet;

export const DEFAULT_MODEL_IDS: Record<ModelRole, AiModelId> = {
  outline: DEFAULT_OUTLINE_MODEL,
  content: DEFAULT_CONTENT_MODEL,
  chat: DEFAULT_CHAT_MODEL,
  research: DEFAULT_RESEARCH_MODEL,
  allocate: DEFAULT_ALLOCATE_MODEL,
};

/** The app's own route for a model: the gateway id, paid by the app. */
export function appModel(id: AiModelId): ResolvedModel {
  return { model: id, id, keyOwner: "app" };
}

/** Gateway ids use dots; Anthropic's API uses hyphens. Only ids listed here can run on a user's key. */
export const ANTHROPIC_API_IDS: Partial<Record<AiModelId, string>> = {
  "anthropic/claude-haiku-4.5": "claude-haiku-4-5",
  "anthropic/claude-sonnet-5": "claude-sonnet-5",
  "anthropic/claude-sonnet-5.5": "claude-sonnet-5-5",
  "anthropic/claude-opus-5": "claude-opus-5",
  "anthropic/claude-opus-5.5": "claude-opus-5-5",
};

export interface DirectProvider {
  apiIds: Partial<Record<AiModelId, string>>;
  create(apiKey: string): (apiId: string) => LanguageModel;
}

/** Providers the app can call directly with a user's key. Adding one is a package, an entry here, and an eval pass. */
export const DIRECT_PROVIDERS: Partial<Record<ModelProvider, DirectProvider>> = {
  anthropic: {
    apiIds: ANTHROPIC_API_IDS,
    create: (apiKey) => {
      const provider = createAnthropic({ apiKey });
      return (apiId) => provider(apiId);
    },
  },
};

/** Pure: the user's decrypted keys by provider decide each role, against the defaults and the registry. */
export function resolveWith(
  keys: Partial<Record<ModelProvider, string>>,
  defaults: Record<ModelRole, AiModelId> = DEFAULT_MODEL_IDS,
  registry: Partial<Record<ModelProvider, DirectProvider>> = DIRECT_PROVIDERS,
): ModelSet {
  const resolve = (id: AiModelId): ResolvedModel => {
    const provider = providerOf(id);
    const key = keys[provider];
    const direct = registry[provider];
    const apiId = direct?.apiIds[id];
    if (!key || !direct || !apiId) return appModel(id);
    return { model: direct.create(key)(apiId), id, keyOwner: "user" };
  };
  return {
    outline: resolve(defaults.outline),
    content: resolve(defaults.content),
    chat: resolve(defaults.chat),
    research: resolve(defaults.research),
    allocate: resolve(defaults.allocate),
  };
}

export interface ResolvedModels extends ModelSet {
  /** Providers whose stored key has a refusal on record, so a success can clear it with one conditional write. */
  keyErrors: Partial<Record<ModelProvider, boolean>>;
}

/** One query, decrypt in memory, resolve. No cache: a removed key stops being used on the next request. */
export async function resolveModels(userId: string): Promise<ResolvedModels> {
  const rows = await getUserApiKeys(userId);
  const keys: Partial<Record<ModelProvider, string>> = {};
  const keyErrors: Partial<Record<ModelProvider, boolean>> = {};
  for (const row of rows) {
    keys[row.provider] = openSecret(row.ciphertext, row.secretVersion);
    if (row.lastError) keyErrors[row.provider] = true;
  }
  return { ...resolveWith(keys), keyErrors };
}
