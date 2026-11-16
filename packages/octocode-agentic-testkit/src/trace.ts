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
	| "cut";

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

export interface Span {
	id: string;
	role: string;
	parent?: string;
	reported: boolean;
}

/** One run: every model request the gateway saw and every event agents, mocks and the gateway reported. */
export class Trace {
	readonly requests: CapturedRequest[] = [];
	readonly events: TraceEvent[] = [];
	readonly spans = new Map<string, Span>();
	cut = false;
	private seq = 0;

	record(e: Omit<TraceEvent, "seq">): TraceEvent {
		const full = { ...e, seq: this.seq++ };
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
		return view;
	}

	toJSON(): unknown {
		return { requests: this.requests, events: this.events, spans: [...this.spans.values()], cut: this.cut };
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
			for (const k of Object.keys(v).sort()) {
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

export function hashOf(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content.map((p) => (typeof p === "string" ? p : ((p as { text?: string }).text ?? ""))).join("\n");
	return content == null ? "" : JSON.stringify(content);
}
