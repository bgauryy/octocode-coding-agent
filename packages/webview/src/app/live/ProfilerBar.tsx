import type { ProfileCacheState } from "@octocodeai/octocode-contracts";

/** Plain text for each state, so the state never rests on colour or pattern alone. */
export const STATE_LABEL: Record<ProfileCacheState, string> = {
	cached: "cached",
	written: "written",
	uncached: "uncached",
	"too-short": "too short to cache",
};

export function Swatch({ state }: { state: ProfileCacheState }) {
	return <span className={`pf-swatch pf-${state}`} aria-hidden="true" />;
}
