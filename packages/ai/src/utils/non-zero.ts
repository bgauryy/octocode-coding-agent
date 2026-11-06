/**
 * First candidate that is a usable, non-zero number, else the fallback.
 * Upstream catalogs and usage reports use 0 (like a missing field) for "unknown", so a
 * plain `??` would keep a meaningless 0 where the fallback is wanted.
 */
export function nonZeroOr(fallback: number, ...candidates: Array<number | null | undefined>): number {
	for (const candidate of candidates) {
		if (typeof candidate === "number" && candidate !== 0 && !Number.isNaN(candidate)) return candidate;
	}
	return fallback;
}
