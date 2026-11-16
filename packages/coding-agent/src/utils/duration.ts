/**
 * The one duration format: `45s`, `2m14s`, `15m`, `1h03m`, `2h`. `precise` adds sub-10s detail for timings
 * (`850ms`, `1.2s`; a whole second is `6s`). A leaf module (no imports) so core renderers can use it without a cycle
 * through `octocode/shared/format.ts`; `format.ts` re-exports it.
 *
 * `{ style: "compact" }` is the coarse form for listings: its two largest units from minutes up (`45m`, `1h 33m`,
 * `2d 3h`), empty under a minute.
 */
export function formatDuration(ms: number, options: boolean | { style: "compact" } = false): string {
	const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
	if (typeof options === "object") return compactDuration(safe);
	const precise = options;
	if (precise && safe < 999.5) return `${Math.round(safe)}ms`;
	if (precise && safe < 9_950) return `${(safe / 1_000).toFixed(1).replace(/\.0$/, "")}s`;
	const seconds = Math.round(safe / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const pad = (value: number, unit: string) => (value ? `${String(value).padStart(2, "0")}${unit}` : "");
	return minutes < 60
		? `${minutes}m${pad(seconds % 60, "s")}`
		: `${Math.floor(minutes / 60)}h${pad(minutes % 60, "m")}`;
}

function compactDuration(ms: number): string {
	const mins = Math.floor(ms / 60_000);
	if (mins < 1) return "";
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}
