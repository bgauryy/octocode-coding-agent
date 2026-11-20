/**
 * The sandbox denials worth a line in a command's result: refused writes and reads of files (`deny(1) file-write-create
 * /path`) and refused connections, from Seatbelt (`network-outbound remote:*:443`) or the proxy (`deny network-outbound
 * host:443 (reason)`). Seatbelt also reports lookups every program makes and that do not matter (`sysctl-read`,
 * `mach-lookup`); those are left out. On Linux the library reports each refused write as `deny <syscall> /path`. Each
 * line is kept once.
 */
const RELEVANT = /\bdeny(?:\(\d+\))? (?:file-write\S*|file-read-data|network-outbound) |^deny [a-z0-9_]+ \//;

function relevantDenials(events: readonly { line: string }[]): string[] {
	return [...new Set(events.map((event) => event.line.trim()).filter((line) => RELEVANT.test(line)))];
}

/** How long to wait at most for Seatbelt's log, which reaches the store within milliseconds of the command's end even under load. */
const WAIT_MS = 1000;

/** The part of srt's violation store this reads: a command's events, and a listener called on each new one. */
export interface ViolationStore {
	getViolationsForCommand(commandId: string): { line: string }[];
	subscribe(listener: (violations: unknown[]) => void): () => void;
}

/**
 * The relevant denials the store holds for `commandId`. Without `wait` it reads once. With `wait` (the command's output
 * showed a refusal) it listens until the first relevant line for the command arrives, or `waitMs` passed.
 */
export function commandDenials(
	store: ViolationStore,
	commandId: string,
	{ wait, waitMs = WAIT_MS }: { wait: boolean; waitMs?: number },
): Promise<string[]> {
	const read = () => relevantDenials(store.getViolationsForCommand(commandId));
	if (!wait) return Promise.resolve(read());
	return new Promise((resolve) => {
		let done = false;
		let stopListening = (): void => undefined;
		const finish = (lines: string[]) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			stopListening();
			resolve(lines);
		};
		const timer = setTimeout(() => finish(read()), waitMs);
		// `subscribe` calls the listener once at once, so lines already stored end the wait before it returns.
		const unsubscribe = store.subscribe(() => {
			const lines = read();
			if (lines.length > 0) finish(lines);
		});
		if (done) unsubscribe();
		else stopListening = unsubscribe;
	});
}
