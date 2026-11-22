import { renderPrompt } from "../../core/prompt-template.ts";
import { HOOK_LIFECYCLE_EVENTS, type HookLifecycleTopic, hookTopic } from "./hook-lifecycle.ts";
import { headerText } from "../shared/fence.ts";
import { type Source, type SourceChannel, type SourceKind, type SourceVerified, trustOf } from "./source-types.ts";
import type { PayloadEvent, Topic } from "./topics.ts";

/**
 * Where an event came from and the one header that tells the model so. The kind, channel and verification come from the
 * code that delivers an event, never from its text; `trust` is derived from them (`trustOf`). Header-like text inside a
 * payload is escaped, so data cannot pass as a header.
 */

/** A source with its trust derived: the only way code builds one. */
export function makeSource(
	kind: SourceKind,
	id: string,
	channel: SourceChannel,
	verified: SourceVerified,
	identity?: Source["identity"],
): Source {
	return { kind, id, channel, verified, trust: trustOf(kind, channel, verified), ...(identity ? { identity } : {}) };
}

/**
 * The source of input a person typed or a client sent. Only the terminal is the user's own channel (trust 4); an ACP or
 * web client confirms sensitive actions in its own client, and an RPC caller is an external source, never the user.
 */
export function userSource(channel: "terminal" | "acp" | "web" | "rpc", id: string = channel): Source {
	return channel === "rpc"
		? makeSource("external", id, "socket", "proven")
		: makeSource(channel, id, channel, "proven");
}

/** What a delivery with no known source reads as: data, nothing known. */
export const UNKNOWN_SOURCE: Source = { kind: "unknown", id: "", channel: "in-process", verified: "none", trust: 0 };

/** What a monitor note that wakes nobody (no event) arrives from. */
export const MONITOR_SOURCE: Source = makeSource("system", "monitor", "in-process", "proven");

/** Per topic: our own code observed it, so it is proven on its channel; its `id` is the part of the payload that names the origin. */
const ORIGIN: { [K in Topic]: (event: PayloadEvent<K>) => Source } = {
	...(Object.fromEntries(
		HOOK_LIFECYCLE_EVENTS.map((event) => [
			hookTopic(event),
			() => makeSource("system", "hooks", "in-process", "proven"),
		]),
	) as { [K in HookLifecycleTopic]: () => Source }),
	"agent.report": (e) => makeSource("child", e.agent, "db", "proven"),
	"agent.ended": (e) => makeSource("child", e.agent, "in-process", "proven"),
	"agent.message": (e) => makeSource("peer", e.from, "db", "self-reported"),
	"job.exit": (e) => makeSource("job", e.job, "in-process", "proven"),
	"item.state": () => makeSource("system", "backlog", "db", "proven"),
	"item.ready": () => makeSource("system", "backlog", "db", "proven"),
	"item.changed": () => makeSource("system", "backlog", "db", "proven"),
	"item.peer": () => makeSource("system", "backlog", "db", "proven"),
	"peer.landed": () => makeSource("system", "peers", "db", "proven"),
	"path.unlocked": () => makeSource("system", "reservations", "db", "proven"),
	"machine.load": () => makeSource("system", "machine", "db", "proven"),
	"monitor.alert": () => makeSource("system", "monitor", "in-process", "proven"),
	"check.result": (e) => makeSource("timer", String(e.timerId), "in-process", "proven"),
	"time.due": (e) => makeSource("timer", String(e.timerId), "in-process", "proven"),
	"hook.feedback": (e) => makeSource("hook", e.hook, "in-process", "proven"),
	"wake.retry": () => makeSource("system", "retry", "in-process", "proven"),
	"peer.notice": () => makeSource("system", "peers", "in-process", "proven"),
	// A ticket result keeps the resolver's own source (`events/tickets.ts`); this is the fallback for a rejection.
	"ticket.resolved": () => makeSource("system", "tickets", "db", "proven"),
	"ticket.rejected": () => makeSource("system", "tickets", "db", "proven"),
};

/** The source an event of its topic arrives with; a delivery that knows better (mail verification) names its own. */
export function sourceOfEvent(event: PayloadEvent): Source {
	// The map is exhaustive over `Topic`, so the entry matches the event's own topic.
	const origin = ORIGIN[event.kind] as (event: PayloadEvent) => Source;
	return origin(event);
}

const MARK: Record<SourceVerified, string> = { proven: "✓", "self-reported": "?", none: "·" };

/** `[src child:warm-carp ✓proven via db] t1`: one line, built from the source's fields with trust re-derived. */
export function renderSourceHeader(source: Source): string {
	const { kind, channel, verified, identity } = source;
	return renderPrompt("notices/source/header.md", {
		kind,
		// `]` would close the header early.
		id: headerText(source.id, 64).replaceAll("]", ")"),
		mark: MARK[verified],
		verified,
		channel: kind === "unknown" ? "" : channel,
		pid: identity?.pid === undefined ? "" : String(identity.pid),
		relay: identity?.via === undefined ? "" : headerText(identity.via, 40).replaceAll("]", ")"),
		trust: trustOf(kind, channel, verified),
	});
}

const SRC_LINE = /^([ \t]*)\[src /gm;
const FENCE_LINE = /^([ \t]*)(<<<)?(untrusted-)/gm;

/**
 * `text` with every line that starts like a source header (and, with `fences`, like a fence marker) defanged, so payload
 * text cannot pass as a header or close a fence. Text already inside one of our fences keeps its markers (`fences: false`).
 */
export function escapeHeaderLike(text: string, options: { fences?: boolean } = {}): string {
	const escaped = text.replace(SRC_LINE, "$1\\[src ");
	return options.fences === false ? escaped : escaped.replace(FENCE_LINE, "$1\\$2$3");
}

function distinct(sources: readonly Source[]): Source[] {
	const seen = new Set<string>();
	return sources.filter((source) => {
		const key = renderSourceHeader(source);
		return !seen.has(key) && seen.add(key);
	});
}

/** A message's content, string or blocks. */
type Content = string | readonly { type: string; text?: string }[];

/**
 * `message` with the header of each distinct source above its text; no source reads as `UNKNOWN_SOURCE`. The body is appended
 * after the headers once, never rewritten later, so the prompt cache prefix stays stable.
 */
export function withSource<M extends { content: Content }>(message: M, sources: readonly Source[]): M {
	const head = distinct(sources.length > 0 ? sources : [UNKNOWN_SOURCE])
		.map(renderSourceHeader)
		.join("\n");
	if (typeof message.content === "string")
		return { ...message, content: `${head}\n${escapeHeaderLike(message.content, { fences: false })}` };
	const blocks = message.content.map((block) =>
		block.type === "text" && typeof block.text === "string"
			? { ...block, text: escapeHeaderLike(block.text, { fences: false }) }
			: block,
	);
	return { ...message, content: [{ type: "text", text: head }, ...blocks] as M["content"] };
}
