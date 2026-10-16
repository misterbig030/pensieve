import type { ModelProvider } from "./models";

export const PROVIDER_NAMES: Record<ModelProvider, string> = { anthropic: "Anthropic", google: "Google", openai: "OpenAI" };

/** The vendor a key belongs to, from its prefix. Anthropic's "sk-ant-" is checked before OpenAI's "sk-". */
export function detectProvider(key: string): ModelProvider | null {
  const k = key.trim();
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (k.startsWith("AIza")) return "google";
  if (k.startsWith("sk-")) return "openai";
  return null;
}

export type KeyCheck = { ok: true } | { ok: false; reason: "invalid" | "unreachable" };

/**
 * Proves a key is accepted by its provider with a call that costs nothing. Anthropic's models endpoint answers 200 for a
 * live key and 401 for a dead one. This proves the key, not the balance. Providers without a route are not checked.
 */
export async function verifyProviderKey(provider: ModelProvider, key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  if (provider !== "anthropic") return { ok: false, reason: "invalid" };
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (res.status === 200) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "invalid" };
    return { ok: false, reason: "unreachable" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
