import { estimateCostUsd, type AiModelId } from "@/lib/ai/models";

interface Tokens {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number | null;
}

/**
 * A call's cost at its model's list price, cached input at the cache-read rate. Used where the gateway's charge is not
 * known: estimates before a run, and calls that ended without one. Throws for a model with no list price: contestants
 * and judges come from `AVAILABLE_MODELS`, so one without is a mistake, not a free call.
 */
export function listPriceUsd(model: AiModelId, tokens: Tokens): number {
  const cost = estimateCostUsd(model, { ...tokens, cacheReadTokens: tokens.cacheReadTokens ?? null });
  if (cost === null) throw new Error(`${model} has no list price in AVAILABLE_MODELS`);
  return cost;
}
