/**
 * Warnings a server launch raises (a rejected allowed folder, a failed install). A launch is prepared several times a
 * turn and outside any command, so each text is queued once per process and the host shows it at the next prompt.
 */
const shown = new Set<string>();
const pending: string[] = [];

/** Queues `message` unless it was already queued in this process. */
export function warnOnce(message: string): void {
	if (shown.has(message)) return;
	shown.add(message);
	pending.push(message);
}

/** The warnings queued since the last call. */
export function takeLaunchWarnings(): string[] {
	return pending.splice(0);
}
