/**
 * Money Octocode computes from list prices, as every surface writes it: an estimate, never a billed amount, so it reads
 * `≈$1.24`, and a negative amount `≈-$0.012`. `digits` keeps the precision a line needs: two for spend totals, more
 * where sub-cent amounts are compared (per-turn costs, cache-warming decisions, one refresh).
 */
export function formatEstimate(usd: number, digits = 2): string {
	return `≈${usd < 0 ? "-" : ""}$${Math.abs(usd).toFixed(digits)}`;
}
