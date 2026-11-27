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

/** Denial lines a note names at most; the rest are counted. */
const MAX_LINES = 20;

/**
 * The part of srt's violation store this reads: a command's events, a listener called on each new one, and how many
 * events it holds now and took in all. It keeps only the latest events of every command (100), so a busy or noisy
 * command can push out another's.
 */
export interface ViolationStore {
	getViolationsForCommand(commandId: string): { line: string }[];
	subscribe(listener: (violations: unknown[]) => void): () => void;
	getCount(): number;
	getTotalCount(): number;
}

/**
 * `lines` as a note lists them, at most `MAX_LINES`, then a line saying how many reports from while the command ran the
 * store dropped (taken since `since` beyond what it holds): those may have been this command's.
 */
function noted(store: ViolationStore, lines: string[], since: number | undefined): string[] {
	const shown =
		lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `… and ${lines.length - MAX_LINES} more`] : lines;
	const dropped = since === undefined ? 0 : store.getTotalCount() - since - store.getCount();
	if (dropped <= 0) return shown;
	return [
		...shown,
		`(the sandbox keeps only its latest reports: ${dropped} from while this command ran were dropped, so refusals may be missing here)`,
	];
}

/**
 * The relevant denials the store holds for `commandId`, as `noted` lists them; `since` is the store's total count when the
 * command started. Without `wait` it reads once. With `wait` (the command's output showed a refusal) it listens until the
 * first relevant line for the command arrives, or `waitMs` passed. Dropped reports are named only beside a line or a
 * suspected refusal.
 */
export function commandDenials(
	store: ViolationStore,
	commandId: string,
	{ wait, waitMs = WAIT_MS, since }: { wait: boolean; waitMs?: number; since?: number },
): Promise<string[]> {
	const read = () => relevantDenials(store.getViolationsForCommand(commandId));
	const note = (lines: string[]) => (lines.length > 0 || wait ? noted(store, lines, since) : lines);
	if (!wait) return Promise.resolve(note(read()));
	return new Promise((resolve) => {
		let done = false;
		let stopListening = (): void => undefined;
		const finish = (lines: string[]) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			stopListening();
			resolve(note(lines));
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
