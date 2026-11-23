/**
 * The stdio servers this process has running, by the pid that leads each one's process group (`stdio.ts` adds and
 * removes them), and who wants to hear when that set changes.
 */

/** Process groups of running servers; each gets SIGTERM if the host exits without closing it (`processLifetime`). */
const liveProcessGroups = new Set<number>();
const listeners = new Set<() => void>();

/** Pids of the stdio servers this process has running (each leads its own process group); empty on Windows. */
export function liveStdioServerPids(): number[] {
	return [...liveProcessGroups];
}

/**
 * Calls `listener` whenever a stdio server starts or exits (`liveStdioServerPids` changed), so a reader of that list (the
 * process sampler that labels this process's children `mcp`) need not wait for its next round. Returns the unsubscribe.
 */
export function onStdioServersChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function changed(): void {
	for (const listener of listeners) listener();
}

export function serverStarted(pid: number): void {
	liveProcessGroups.add(pid);
	changed();
}

export function serverExited(pid: number): void {
	if (liveProcessGroups.delete(pid)) changed();
}
