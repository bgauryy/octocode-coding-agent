import type { Endpoint, FeedCursor, ProfileMessage, TrafficState } from "@octocodeai/octocode-contracts";
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

/** Where the page of messages older than `message` starts: its time and its key, `m:` and the id padded to 12 digits as the host keys a team message. */
export function messageCursor(message: Pick<ProfileMessage, "id" | "at">): FeedCursor {
	return { at: message.at, key: `m:${String(message.id).padStart(12, "0")}` };
}

/** Which messages the tab lists: the team's own (the default), the internal notices, or both. */
export type MessageScope = "team" | "internal" | "all";

export const MESSAGE_SCOPES: ReadonlyArray<{ scope: MessageScope; label: string }> = [
	{ scope: "team", label: "Messages" },
	{ scope: "internal", label: "Internal" },
	{ scope: "all", label: "All" },
];

const inScope = (message: ProfileMessage, scope: MessageScope): boolean =>
	scope === "all" || (scope === "internal") === (message.internal === true);

/** The messages the scope lists. */
export function scopedMessages(messages: readonly ProfileMessage[], scope: MessageScope): ProfileMessage[] {
	return messages.filter((message) => inScope(message, scope));
}

/** One end of a message as a row shows it: the name, its role and where it runs. */
export interface RouteEnd {
	id: string;
	role?: string;
	/** `worktree fix-a`, a branch and `tmux %12`, in that order; none for an end whose facts are unknown. */
	marks: string[];
	departed: boolean;
}

/** `tmux %12`: the pane an agent runs in, marked the way the terminal marks it. */
const paneMark = (pane: string): string => `tmux ${pane}`;

/** An end of a message from its endpoint; the bare id when the host sent none. */
function routeEnd(id: string, endpoint: Endpoint | undefined): RouteEnd {
	return {
		id,
		...(endpoint?.role ? { role: endpoint.role } : {}),
		marks: [
			...(endpoint?.worktree ? [endpoint.worktree] : []),
			...(endpoint?.branch ? [endpoint.branch] : []),
			...(endpoint?.tmuxPane ? [paneMark(endpoint.tmuxPane)] : []),
		],
		departed: endpoint?.departed === true,
	};
}

/** `tidal-coral (reviewer)`; the role only when it adds to the name, `user` or `team` being their own role. */
export function endLabel(end: Pick<RouteEnd, "id" | "role">): string {
	return end.role && end.role !== end.id ? `${end.id} (${end.role})` : end.id;
}

export interface MessageRoute {
	from: RouteEnd;
	to: Array<RouteEnd & { state?: TrafficState }>;
}

/** Sender and recipients of a message; with several recipients each carries its own delivery state. */
export function messageRoute(message: ProfileMessage): MessageRoute {
	const ends = new Map((message.toEndpoints ?? []).map((endpoint) => [endpoint.id, endpoint]));
	const states = new Map((message.deliveries ?? []).map((delivery) => [delivery.recipient, delivery.state]));
	return {
		from: routeEnd(message.from, message.fromEndpoint),
		to: message.to.map((id) => ({
			...routeEnd(id, ends.get(id)),
			...(message.to.length > 1 && states.has(id) ? { state: states.get(id) } : {}),
		})),
	};
}

/** `main \u2192 tidal (reviewer), shy-clam`: the route as one line, for a label. */
export function routeText(route: MessageRoute): string {
	return `${endLabel(route.from)} \u2192 ${route.to.map(endLabel).join(", ")}`;
}

/** Messages matching the filter text (the whole message when the host sent it), the range and one agent as sender or receiver. */
export function filterMessages(
	messages: readonly ProfileMessage[],
	options: {
		filter: string;
		range: ProfileRange | undefined;
		agentId?: string;
		pair?: PairKey;
		scope?: MessageScope;
	},
): ProfileMessage[] {
	const needle = options.filter.trim().toLowerCase();
	return messages.filter((message) => {
		if (!inScope(message, options.scope ?? "team")) return false;
		if (options.agentId && message.from !== options.agentId && !message.to.includes(options.agentId)) return false;
		if (options.pair && (message.from !== options.pair.from || !message.to.includes(options.pair.to))) return false;
		if (!overlapsRange(message.at, message.at + (message.deliveredMs ?? 0), options.range)) return false;
		if (!needle) return true;
		return [
			message.text ?? message.preview,
			message.from,
			message.label ?? "",
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
