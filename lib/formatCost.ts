/** What the gateway charged; a dash for a call it never saw (the user's own key). */
export function formatCostUsd(costUsd: number | null): string {
  if (costUsd === null) return "—";
  if (costUsd === 0) return "$0";
  if (costUsd < 0.0001) return "< $0.0001";
  return `$${costUsd.toFixed(4)}`;
}
