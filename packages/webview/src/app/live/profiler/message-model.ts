import type { ProfileMessage } from "@octocodeai/octocode-contracts";
import type { ProfileRange } from "./panel-props.ts";
import { formatLatency } from "./trace-format.ts";
import { overlapsRange } from "./trace-view.ts";

/** Pure thread grouping, flow counts, state pills and filtering for the Messages panel. */

export interface ThreadRow {
	message: ProfileMessage;
	/** 0 for a message that starts a thread (or whose parent is not in the list). */
	depth: number;
}

/** Messages in thread order: each root by time, its replies (by `replyTo`) indented beneath it. */
export function groupThreads(messages: readonly ProfileMessage[]): ThreadRow[] {
	const ids = new Set(messages.map((message) => message.id));
	const replies = new Map<number | undefined, ProfileMessage[]>();
	for (const message of messages) {
		const key =
			message.replyTo !== undefined && message.replyTo !== message.id && ids.has(message.replyTo)
				? message.replyTo
				: undefined;
		replies.set(key, [...(replies.get(key) ?? []), message]);
	}
	const byTime = (a: ProfileMessage, b: ProfileMessage) => a.at - b.at || a.id - b.id;
	const rows: ThreadRow[] = [];
	const seen = new Set<number>();
	const walk = (key: number | undefined, depth: number) => {
		for (const message of [...(replies.get(key) ?? [])].sort(byTime)) {
			if (seen.has(message.id)) continue;
			seen.add(message.id);
			rows.push({ message, depth });
			walk(message.id, depth + 1);
		}
	};
	walk(undefined, 0);
	return rows;
}

/** Messages matching the filter text (the whole message when the host sent it), the range and one agent as sender or receiver. */
export function filterMessages(
	messages: readonly ProfileMessage[],
	options: { filter: string; range: ProfileRange | undefined; agentId?: string; pair?: PairKey },
): ProfileMessage[] {
	const needle = options.filter.trim().toLowerCase();
	return messages.filter((message) => {
		if (options.agentId && message.from !== options.agentId && !message.to.includes(options.agentId)) return false;
		if (options.pair && (message.from !== options.pair.from || !message.to.includes(options.pair.to))) return false;
		if (!overlapsRange(message.at, message.at + (message.deliveredMs ?? 0), options.range)) return false;
		if (!needle) return true;
		return [
			message.text ?? message.preview,
			message.from,
			message.to.join(" "),
			message.state,
			String(message.id),
		].some((text) => text.toLowerCase().includes(needle));
	});
}

export interface PairKey {
	from: string;
	to: string;
}

export interface FlowPair extends PairKey {
	count: number;
	/** Sent but not yet answered. */
	awaiting: number;
	queued: number;
	deadLettered: number;
}

/** Messages counted per sender and receiver, busiest pair first. */
export function flowPairs(messages: readonly ProfileMessage[]): FlowPair[] {
	const pairs = new Map<string, FlowPair>();
	for (const message of messages) {
		for (const to of message.to) {
			const key = `${message.from}\u0000${to}`;
			const pair = pairs.get(key) ?? { from: message.from, to, count: 0, awaiting: 0, queued: 0, deadLettered: 0 };
			pair.count += 1;
			if (message.state === "awaiting reply") pair.awaiting += 1;
			if (message.state === "queued") pair.queued += 1;
			if (message.state === "dead-lettered") pair.deadLettered += 1;
			pairs.set(key, pair);
		}
	}
	return [...pairs.values()].sort(
		(a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
	);
}

/** `main \u2192 tidal-coral 4 \u00B7 1 awaiting reply`: what the pair's chip says. */
export function flowLabel(pair: FlowPair): string {
	const extras = [
		pair.awaiting && `${pair.awaiting} awaiting reply`,
		pair.queued && `${pair.queued} queued`,
		pair.deadLettered && `${pair.deadLettered} dead-lettered`,
	].filter(Boolean);
	return [`${pair.from} \u2192 ${pair.to} ${pair.count}`, ...extras].join(" \u00B7 ");
}

export const MESSAGE_STATES: Record<
	ProfileMessage["state"],
	{ symbol: string; tone: "neutral" | "tool" | "warning" | "success" | "danger" }
> = {
	queued: { symbol: "\u25CB", tone: "neutral" },
	delivered: { symbol: "\u2713", tone: "tool" },
	"awaiting reply": { symbol: "\u2026", tone: "warning" },
	answered: { symbol: "\u2713\u2713", tone: "success" },
	"dead-lettered": { symbol: "\u2715", tone: "danger" },
};

/** `delivered 80ms \u00B7 answered 1m 12s`; a dash for a step the message has not reached. */
export function latencyText(message: Pick<ProfileMessage, "deliveredMs" | "answeredMs">): string {
	return `delivered ${formatLatency(message.deliveredMs)} \u00B7 answered ${formatLatency(message.answeredMs)}`;
}
