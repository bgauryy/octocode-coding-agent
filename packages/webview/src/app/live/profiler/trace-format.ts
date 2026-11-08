/** Time formatting for the Trace and Messages panels. */

/** `850ms`, `2.4s`, `1m 5s`, `1h 2m`. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A latency, or a dash when the lifecycle has not reached that step. */
export function formatLatency(ms: number | undefined): string {
	return ms === undefined ? "\u2014" : formatDuration(ms);
}

/** Offset from the session start: `+0ms`, `+2.4s`. */
export function formatOffset(time: number, origin: number): string {
	return `+${formatDuration(Math.max(0, time - origin))}`;
}
