import type { SessionEntry } from "../../../core/session-manager.ts";

/** Per-entry dependencies preserve tool ownership even when a provider reuses a call ID. */
export class SessionWindowIndex {
	readonly rendered: Uint8Array;
	readonly liveOwners = new Map<string, number>();
	private readonly links = new Map<number, number[]>();

	constructor(entries: readonly SessionEntry[], floor: number, liveIds?: ReadonlySet<string>) {
		this.rendered = new Uint8Array(entries.length);
		const calls = new Map<string, number>();
		const pendingCalls = new Map<string, number>();
		const ends = new Int32Array(entries.length).fill(-1);
		let previousNonResult = floor;
		const link = (a: number, b: number) => {
			if (a === b) return;
			const from = this.links.get(a) ?? [];
			from.push(b);
			this.links.set(a, from);
			const to = this.links.get(b) ?? [];
			to.push(a);
			this.links.set(b, to);
		};
		for (let index = floor; index < entries.length; index++) {
			const entry = entries[index];
			if (entry.type === "message" && entry.message.role === "toolResult") {
				const owner = calls.get(entry.message.toolCallId) ?? previousNonResult;
				link(owner, index);
				ends[owner] = index;
				const pending = pendingCalls.get(entry.message.toolCallId);
				if (pending !== undefined) {
					link(pending, index);
					ends[pending] = index;
					pendingCalls.delete(entry.message.toolCallId);
				}
				this.liveOwners.delete(entry.message.toolCallId);
			} else {
				previousNonResult = index;
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				for (const block of entry.message.content ?? []) {
					if (block.type !== "toolCall") continue;
					calls.set(block.id, index);
					if (entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted") {
						// Only unresolved reuse overwrites a pending slot. Completed reuse is independent.
						const previous = pendingCalls.get(block.id);
						if (previous !== undefined) link(previous, index);
						pendingCalls.set(block.id, index);
						this.liveOwners.delete(block.id);
						if (liveIds?.has(block.id)) this.liveOwners.set(block.id, index);
					}
				}
			}
		}
		// Crossed call/result groups were indivisible in the contiguous window. Keep
		// their tool entries together, without retaining the reports between them.
		let group = floor;
		let through = -1;
		for (let index = floor; index < entries.length; index++) {
			if (ends[index] < index) continue;
			if (index <= through) link(group, index);
			else group = index;
			through = Math.max(through, ends[index]);
		}
	}

	/** Each entry and dependency is visited only once over the lifetime of a window. */
	select(seeds: Iterable<number>): number[] {
		const selected: number[] = [];
		const add = (index: number) => {
			if (this.rendered[index]) return;
			this.rendered[index] = 1;
			selected.push(index);
		};
		for (const index of seeds) add(index);
		for (let cursor = 0; cursor < selected.length; cursor++)
			for (const linked of this.links.get(selected[cursor]) ?? []) add(linked);
		return selected.sort((a, b) => a - b);
	}
}
