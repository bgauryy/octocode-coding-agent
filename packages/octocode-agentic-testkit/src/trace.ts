import { createHash } from "node:crypto";

export interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: unknown;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
	name?: string;
	/**
	 * Anthropic wire only: the raw content blocks of a system message (the top-level `system` array or a mid-conversation
	 * `system` turn) and of any message carrying a block type beyond text, tool_use and tool_result, such as
	 * `tool_addition` / `tool_removal`. Not part of the canonical form, so cassette keys do not depend on it.
	 */
	blocks?: Record<string, unknown>[];
}

export interface Usage {
	promptTokens: number;
	cachedTokens: number;
	completionTokens: number;
	/** Token counts are estimates (chars / 4) unless forwarded from a real provider. */
	estimated: boolean;
}

export interface CapturedRequest {
	index: number;
	agent: string;
	span: string;
	model: string;
	stream: boolean;
	messages: ChatMessage[];
	tools: string[];
	raw: unknown;
	canonical: string;
	hash: string;
	bytes: number;
	usage?: Usage;
	/** USD for this request when the gateway has a price table (`caps.pricing`); estimated when `usage.estimated`. */
	costUsd?: number;
}

export type EventKind =
	| "model_tool_call"
	| "answer"
	| "tool_exec"
	| "tool_error"
	| "skill_load"
	| "memory_read"
	| "memory_write"
	| "spawn"
	| "report"
	| "compaction"
	| "cut"
	| "guard";

export interface TraceEvent {
	seq: number;
	kind: EventKind;
	span: string;
	agent: string;
	name?: string;
	args?: unknown;
	data?: unknown;
	server?: string;
}

/** A position in a trace (`Trace.mark()`). */
export interface TraceMark {
	requests: number;
	events: number;
}

export interface Span {
	id: string;
	role: string;
	parent?: string;
	reported: boolean;
}

const EVENT_PROBE_KINDS = new Set<EventKind>([
	"skill_load",
	"memory_read",
	"memory_write",
	"spawn",
	"report",
	"compaction",
]);

/** One run: every model request the gateway saw and every event agents, mocks and the gateway reported. */
export class Trace {
	readonly requests: CapturedRequest[] = [];
	readonly events: TraceEvent[] = [];
	readonly spans = new Map<string, Span>();
	/**
	 * What this run can see: `"events"` (the adapter reports harness events), `` `mcp:${server}` `` (a mock server),
	 * `"guards"`, and `"lineage"` (the gateway infers agents from header-less requests). A matcher that needs a probe
	 * throws when it is absent.
	 */
	readonly probes = new Set<string>();
	/** A cap or a guard stopped part of the run (`cut` and `guard` events say which). */
	cut = false;
	private seq = 0;

	/** Declare that a source (adapter, mock) reports into this trace, so "nothing happened" is evidence. */
	observe(probe: string): void {
		this.probes.add(probe);
	}

	/**
	 * Append an event. A harness event kind (skill, memory, spawn, report, compaction) marks the `events` probe as
	 * wired, unless `inferred`: the gateway's own lineage guesses (`data.inferred: true`) never claim that the
	 * harness reports events.
	 */
	record(e: Omit<TraceEvent, "seq">, opts: { inferred?: boolean } = {}): TraceEvent {
		const data =
			opts.inferred && (e.data === undefined || (typeof e.data === "object" && !Array.isArray(e.data)))
				? { ...(e.data as Record<string, unknown> | undefined), inferred: true }
				: opts.inferred
					? { value: e.data, inferred: true }
					: e.data;
		const full = { ...e, ...(data === undefined ? {} : { data }), seq: this.seq++ };
		if (EVENT_PROBE_KINDS.has(e.kind) && !opts.inferred) this.probes.add("events");
		this.events.push(full);
		return full;
	}

	addSpan(span: Span): void {
		this.spans.set(span.id, span);
	}

	of(kind: EventKind, agent?: string): TraceEvent[] {
		return this.events.filter((e) => e.kind === kind && (agent === undefined || e.agent === agent));
	}

	/** A view of one agent's part of the run; every matcher works on it. */
	agent(role: string): Trace {
		const view = new Trace();
		view.requests.push(...this.requests.filter((r) => r.agent === role));
		view.events.push(...this.events.filter((e) => e.agent === role));
		for (const s of this.spans.values()) if (s.role === role) view.addSpan(s);
		view.cut = this.cut;
		for (const p of this.probes) view.probes.add(p);
		return view;
	}

	/** The current end of the trace, for `since`. */
	mark(): TraceMark {
		return { requests: this.requests.length, events: this.events.length };
	}

	/** A view of what was recorded after `mark` (one turn); `cut` is set when a cut or guard event falls in it. */
	since(mark: TraceMark): Trace {
		const view = new Trace();
		view.requests.push(...this.requests.slice(mark.requests));
		view.events.push(...this.events.slice(mark.events));
		for (const s of this.spans.values()) view.addSpan(s);
		view.cut = view.events.some((e) => e.kind === "cut" || e.kind === "guard");
		for (const p of this.probes) view.probes.add(p);
		return view;
	}

	toJSON(): unknown {
		return {
			requests: this.requests,
			events: this.events,
			spans: [...this.spans.values()],
			probes: [...this.probes],
			cut: this.cut,
		};
	}
}

const SECRET = /(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{12,})/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+Z?)?\b/g;
const CALL_ID = /\b(call|toolu|tc)_[A-Za-z0-9_-]{4,}\b/g;

export interface CanonicalOptions {
	/** Absolute paths (sandbox roots) replaced by `<ws>`. */
	roots?: string[];
	/** Redact secrets only: keep dates, call ids and paths, so a real timestamp is a real difference. */
	raw?: boolean;
}

export function redact(text: string): string {
	return text.replace(SECRET, "<secret>");
}

/**
 * Canonical form: sorted keys, cache markers dropped, ids, dates, sandbox paths and secrets replaced.
 * With `raw` only secrets are replaced (cache checks); the masked form keys cassettes.
 */
export function canonicalize(value: unknown, opts: CanonicalOptions = {}): string {
	const strip = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(strip);
		if (v && typeof v === "object") {
			const out: Record<string, unknown> = {};
			for (const k of Object.keys(v).toSorted()) {
				if (k === "cache_control") continue;
				out[k] = strip((v as Record<string, unknown>)[k]);
			}
			return out;
		}
		if (typeof v === "string") {
			let s = redact(v);
			if (opts.raw) return s;
			s = s.replace(CALL_ID, "<id>").replace(ISO_DATE, "<date>");
			for (const root of opts.roots ?? []) s = s.split(root).join("<ws>");
			return s;
		}
		return v;
	};
	return JSON.stringify(strip(value));
}

const PLAIN_TEXT_KEYS = new Set(["type", "text", "cache_control"]);

/**
 * A message as a provider's prompt cache reads it: blocks that are only text (cache markers aside) say nothing the
 * `content` text does not, so they are dropped. A harness that sends one system turn as a string in one request and
 * as text blocks in the next keeps its cached prefix.
 */
export function cacheForm(m: ChatMessage): ChatMessage {
	if (!m.blocks?.every((b) => b.type === "text" && Object.keys(b).every((k) => PLAIN_TEXT_KEYS.has(k)))) return m;
	const { blocks: _blocks, ...rest } = m;
	return rest;
}

/** `mcp__<server>__<tool>`, as agents namespace MCP tools; server characters outside [A-Za-z0-9_] become `_`. */
export const mcpToolName = (server: string, tool: string): string =>
	`mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__${tool}`;

/** A tool-name pattern: an exact name, a glob where `*` matches any run of characters, or a RegExp. */
export type NamePattern = string | RegExp;

export function matchName(pattern: NamePattern, name: string | undefined): boolean {
	if (name === undefined) return false;
	if (pattern instanceof RegExp) return pattern.test(name);
	if (!pattern.includes("*")) return pattern === name;
	const re = pattern
		.split("*")
		.map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${re}$`).test(name);
}

/** Event data as text: a string as is, anything else as JSON. */
export const dataText = (data: unknown): string => (typeof data === "string" ? data : JSON.stringify(data ?? null));

/** Why a guard fired: the `reason` of a `guard` event's data. */
export const guardReason = (e: TraceEvent): string => dataText((e.data as { reason?: unknown } | undefined)?.reason);

export function hashOf(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content.map((p) => (typeof p === "string" ? p : ((p as { text?: string }).text ?? ""))).join("\n");
	return content == null ? "" : JSON.stringify(content);
}
