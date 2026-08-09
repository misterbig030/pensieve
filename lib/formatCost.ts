export function formatCostUsd(costUsd: number): string {
  if (costUsd === 0) return "$0";
  if (costUsd < 0.0001) return "< $0.0001";
  return `$${costUsd.toFixed(4)}`;
}
