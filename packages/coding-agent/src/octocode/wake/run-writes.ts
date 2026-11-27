import { itemKey } from "./gate-types.ts";

/** The items a run wrote with its tool calls, so a nudge about one of them can be dropped. */
export class RunWrites {
	/** Items the current (or just ended) run wrote. */
	private wrote = new Set<string>();
	/** Calls of tools that write items, by call id, until the tool ends. */
	private readonly calls = new Map<string, string[]>();

	/** A new run: what the last one wrote is forgotten. */
	reset(): void {
		this.wrote = new Set();
	}

	/** A tool that writes items starts: its call id and the item refs it names. */
	started(callId: string, refs: readonly string[]): void {
		if (refs.length > 0) this.calls.set(callId, [...refs]);
	}

	/** The tool ended; a call that did not fail counts as the run writing those items. */
	ended(callId: string, failed: boolean): void {
		const refs = this.calls.get(callId);
		this.calls.delete(callId);
		if (failed || !refs) return;
		for (const ref of refs) {
			const key = itemKey(ref);
			if (key) this.wrote.add(key);
		}
	}

	has(ref: string): boolean {
		const key = itemKey(ref);
		return key !== undefined && this.wrote.has(key);
	}

	clear(): void {
		this.calls.clear();
		this.wrote.clear();
	}
}
