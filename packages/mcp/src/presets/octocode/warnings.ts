/**
 * Warnings the research server's launch raises (a rejected allowed folder, a replaced root list). A launch is prepared
 * several times a turn and outside any command, so the text is queued once and the host shows it at the next prompt
 * (`McpServerPreset.takeWarnings`).
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
export function takeOctocodeWarnings(): string[] {
	return pending.splice(0);
}
