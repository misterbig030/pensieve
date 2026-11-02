import type { ModelCall } from "@/lib/ai/logged";
import { estimateCostUsd } from "@/lib/ai/models";

/** A dollar amount for the admin; a dash when there is none to show. */
export function formatCostUsd(costUsd: number | null): string {
  if (costUsd === null) return "—";
  if (costUsd === 0) return "$0";
  if (costUsd < 0.0001) return "< $0.0001";
  return `$${costUsd.toFixed(4)}`;
}

export type CostedCall = Pick<ModelCall, "model" | "keyOwner" | "costUsd" | "inputTokens" | "outputTokens" | "cacheReadTokens">;

export interface CallCost {
  usd: number | null;
  /** True for a call on the user's own key: the gateway never saw it, so its cost is the list-price estimate. */
  estimated: boolean;
}

/** What a call cost: the gateway's charge on Pensieve's key, an estimate on the user's own key. */
export function callCost(call: CostedCall): CallCost {
  if (call.keyOwner === "user") return { usd: estimateCostUsd(call.model, call), estimated: true };
  return { usd: call.costUsd, estimated: false };
}

/** The calls' costs added up, the gateway's charges apart from the estimates. */
export function sumCallCosts(calls: CostedCall[]): { chargedUsd: number; estimatedUsd: number; estimatedCalls: number } {
  return calls.reduce(
    (t, c) => {
      const cost = callCost(c);
      return cost.estimated
        ? { ...t, estimatedUsd: t.estimatedUsd + (cost.usd ?? 0), estimatedCalls: t.estimatedCalls + 1 }
        : { ...t, chargedUsd: t.chargedUsd + (cost.usd ?? 0) };
    },
    { chargedUsd: 0, estimatedUsd: 0, estimatedCalls: 0 },
  );
}

/** A call's cost as the admin reads it: an estimate marked with ≈. */
export function formatCallCost(cost: CallCost): string {
  const amount = formatCostUsd(cost.usd);
  return cost.estimated && cost.usd !== null ? `≈ ${amount}` : amount;
}
