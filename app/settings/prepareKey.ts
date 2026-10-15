import type { ModelProvider } from "@/lib/ai/models";
import { PROVIDER_NAMES, detectProvider } from "@/lib/ai/providerKeys";
import { DIRECT_PROVIDERS } from "@/lib/ai/resolve";

export type PreparedKey = { ok: true; provider: ModelProvider; key: string } | { ok: false; message: string };

/** Trims the pasted key, names its vendor, and refuses vendors the app cannot route to yet. Pure; the action calls it first. */
export function prepareKey(raw: string): PreparedKey {
  const key = raw.trim();
  const provider = detectProvider(key);
  if (!provider) return { ok: false, message: "That key isn't one Pensieve recognises. Nothing was saved." };
  if (!DIRECT_PROVIDERS[provider]) {
    const article = provider === "openai" ? "an" : "a";
    return { ok: false, message: `That looks like ${article} ${PROVIDER_NAMES[provider]} key. Pensieve runs on Claude models, so it can't be used yet. Nothing was saved.` };
  }
  return { ok: true, provider, key };
}
