import type { Reply } from "./reply.ts";
import { canonicalize, hashOf, textOf, type ChatMessage, type Trace } from "./trace.ts";

/*
 * Agent lineage for harnesses that send no `x-testkit-agent` header (every real CLI). Each request joins the
 * conversation it belongs to, in this order:
 *
 * 1. Continuation: it starts with a known conversation's last messages. One that extends a conversation, has tools
 *    and answers none of its pending tool calls is a forked child of it instead.
 * 2. Spawn: its first user message holds a string argument (12+ characters) of a tool call no child claimed yet, as
 *    spawn tools pass the task. Answered calls count too, for harnesses whose spawn tool returns at once and runs the
 *    child in the background. The child's role is the call's `subagent_type`, `agent_type`, `agent`, `role`, `type`,
 *    `profile` or `name` argument, else the tool name.
 * 3. Rewrite: the same system prompt and tools as a known conversation, and it keeps that conversation's first
 *    message, one of its model or tool messages, or a text the gateway answered. When the history shrank, it is a
 *    `compaction`.
 * 4. Spawn without a task match: a conversation has a pending call no child claimed, and the request has tools and a
 *    different system prompt or tool set.
 * 5. Otherwise the first request is `main`, a fresh conversation with main's prompt and tools is a new `main`
 *    session, and anything else is a side request (`<role>:aux`), such as a title or summary call.
 *
 * A child reports when, after it answered, its parent's history gains the spawn call's tool result or a message
 * holding the child's answer (a background-task notification).
 */

interface Call {
	id: string;
	name: string;
	args: unknown;
	child?: Thread;
}

interface Thread {
	span: string;
	role: string;
	parent?: Thread;
	/** The call that started this child. */
	via?: Call;
	/** Canonical non-system messages of the thread's latest request. */
	history: string[];
	/** The text of the conversation's first user message: a task, or the user's prompt. */
	first: string;
	size: number;
	identity: string;
	/** Tool calls of the last reply, until the next request of this thread. */
	pending: Call[];
	/** Every tool call this thread made, for spawn matching. */
	calls: Call[];
	children: Thread[];
	answer?: string;
	reported: boolean;
	last: number;
}

const ROLE_KEYS = ["subagent_type", "agent_type", "agent", "role", "type", "profile", "name"];
const MIN_TASK = 12;
const MIN_ANSWER = 8;
const MIN_SUMMARY = 20;

const strip = ({ blocks: _blocks, ...m }: ChatMessage): Omit<ChatMessage, "blocks"> => m;
const recent = (threads: Thread[]): Thread[] => threads.toSorted((a, b) => b.last - a.last);
const sizeOf = (convo: string[]): number => convo.reduce((n, c) => n + c.length, 0);

function strings(v: unknown, out: string[] = []): string[] {
	if (typeof v === "string") out.push(v);
	else if (Array.isArray(v)) for (const x of v) strings(x, out);
	else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
	return out;
}

function roleOf(call: Call): string {
	const args = (call.args ?? {}) as Record<string, unknown>;
	for (const k of ROLE_KEYS) {
		const v = args[k];
		if (typeof v === "string" && v.trim() && v.length <= 64 && !/\s/.test(v.trim())) return v.trim();
	}
	return call.name;
}

const parseArgs = (s: string): unknown => {
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
};

const answers = (m: ChatMessage, c: Call): boolean =>
	m.role === "tool" && (m.tool_call_id === c.id || m.tool_call_id === c.name);

/** Infers which agent each header-less request belongs to and records the spawns, reports and compactions it implies. */
export class Lineage {
	private readonly threads: Thread[] = [];
	private readonly roleCount = new Map<string, number>();
	private readonly texts: string[] = [];
	private readonly trace: Trace;
	/** The first user message of the request being assigned, for a thread `add` creates. */
	private first = "";

	constructor(trace: Trace) {
		this.trace = trace;
	}

	/**
	 * The agent and span of a request that carries no identity header; call before answering it. The first call
	 * wires the `lineage` probe: from then on the gateway's view of spawns and compactions is evidence.
	 */
	assign(messages: ChatMessage[], tools: unknown, index: number): { agent: string; span: string } {
		this.trace.observe("lineage");
		const system = messages.filter((m) => m.role === "system").map(strip);
		const rest = messages.filter((m) => m.role !== "system");
		const convo = rest.map((m) => canonicalize(strip(m), { raw: true }));
		// Masked: a date or id that changes inside the system prompt keeps the conversation's identity.
		const identity = hashOf(canonicalize({ system, tools: tools ?? [] }));
		const hasTools = Array.isArray(tools) && tools.length > 0;
		const first = textOf(rest.find((m) => m.role === "user")?.content).trim();
		this.first = first;
		const thread =
			this.continuation(convo, rest, identity, hasTools) ??
			this.taskSpawn(first, convo, identity) ??
			this.rewrite(convo, rest, identity) ??
			this.weakSpawn(hasTools, convo, identity) ??
			this.fresh(convo, identity);
		thread.last = index;
		return { agent: thread.role, span: thread.span };
	}

	/** Remember the reply the gateway sent a span: its tool calls stay pending until the next request answers them. */
	settle(span: string, reply: Reply): void {
		const t = this.threads.find((x) => x.span === span);
		if (!t) return;
		t.pending = reply.toolCalls.map((c) => ({ id: c.id, name: c.name, args: parseArgs(c.arguments) }));
		t.calls.push(...t.pending);
		const text = reply.text.trim();
		t.answer = reply.toolCalls.length === 0 ? text : undefined;
		if (text.length >= MIN_SUMMARY) this.texts.push(text);
	}

	private continuation(convo: string[], rest: ChatMessage[], identity: string, hasTools: boolean): Thread | undefined {
		let best: Thread | undefined;
		for (const t of this.threads) {
			if (!t.history.length || t.history.length > convo.length) continue;
			if (!t.history.every((h, i) => h === convo[i])) continue;
			// The longest match wins; on a tie, the conversation with this request's prompt and tools, then the latest.
			const rank = (x: Thread): [number, number, number] => [x.history.length, x.identity === identity ? 1 : 0, x.last];
			const [a, b] = [rank(t), best ? rank(best) : undefined];
			if (!b || a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best = t;
		}
		if (!best) return undefined;
		const added = rest.slice(best.history.length);
		const answersPending = best.pending.some((p) => added.some((m) => answers(m, p)));
		// A request that resends a conversation is that conversation, even with another system prompt: splitting it
		// off would hide a rewritten prompt from the prefix checks. A side call that resends main's history therefore
		// reads as main's turn, a loud prefix break rather than a silent pass.
		const forked = hasTools && convo.length > best.history.length;
		if (forked && best.pending.length && !answersPending) {
			const call = best.pending.find((p) => !p.child) ?? best.pending[0];
			return this.spawn(best, call, convo, identity);
		}
		this.reports(best, added);
		return this.move(best, convo, identity);
	}

	private taskSpawn(first: string, convo: string[], identity: string): Thread | undefined {
		if (first.length < MIN_TASK) return undefined;
		// The same first message is the same conversation, rewritten: never a child.
		if (this.threads.some((t) => t.first === first)) return undefined;
		for (const t of recent(this.threads))
			for (const c of t.calls.toReversed()) {
				if (c.child) continue;
				// A string the parent already had (a path, the user's words) says nothing about a new task.
				const task = (s: string): boolean => s.length >= MIN_TASK && !t.first.includes(s);
				const hit = strings(c.args).some((s) => task(s) && (first.includes(s) || s.includes(first)));
				if (hit) return this.spawn(t, c, convo, identity);
			}
		return undefined;
	}

	private rewrite(convo: string[], rest: ChatMessage[], identity: string): Thread | undefined {
		const text = rest.map((m) => textOf(m.content)).join("\n");
		const summarized = this.texts.some((a) => text.includes(a));
		const t = recent(this.threads).find((x) => {
			if (x.identity !== identity) return false;
			const old = new Set(x.history);
			const kept = rest.some((m, i) => (m.role === "assistant" || m.role === "tool") && old.has(convo[i]));
			return kept || summarized || convo[0] === x.history[0];
		});
		if (!t) return undefined;
		const old = new Set(t.history);
		this.reports(
			t,
			rest.filter((_, i) => !old.has(convo[i])),
		);
		if (sizeOf(convo) < t.size)
			this.trace.record(
				{ kind: "compaction", agent: t.role, span: t.span, data: { from: t.history.length, to: convo.length } },
				{ inferred: true },
			);
		return this.move(t, convo, identity);
	}

	private weakSpawn(hasTools: boolean, convo: string[], identity: string): Thread | undefined {
		if (!hasTools) return undefined;
		const t = recent(this.threads).find((x) => x.identity !== identity && x.pending.some((p) => !p.child));
		const call = t?.pending.find((p) => !p.child);
		return t && call ? this.spawn(t, call, convo, identity) : undefined;
	}

	private fresh(convo: string[], identity: string): Thread {
		const main = this.threads.find((t) => t.role === "main");
		if (!main || main.identity === identity) return this.add("main", convo, identity);
		const role = recent(this.threads)[0].role.replace(/:aux$/, "");
		return this.add(`${role}:aux`, convo, identity);
	}

	/** Children of `parent` that answered and whose answer now reached it: the spawn's tool result or their text. */
	private reports(parent: Thread, added: ChatMessage[]): void {
		if (!added.length) return;
		const text = added.map((m) => textOf(m.content)).join("\n");
		for (const child of parent.children) {
			if (child.reported || child.answer === undefined || !child.via) continue;
			const via = child.via;
			const result = added.find((m) => answers(m, via));
			const notified = child.answer.length >= MIN_ANSWER && text.includes(child.answer);
			if (!result && !notified) continue;
			child.reported = true;
			this.trace.record(
				{
					kind: "report",
					agent: child.role,
					span: child.span,
					name: parent.role,
					data: result ? textOf(result.content) : child.answer,
				},
				{ inferred: true },
			);
			const span = this.trace.spans.get(child.span);
			if (span) span.reported = true;
		}
	}

	private move(t: Thread, convo: string[], identity: string): Thread {
		t.pending = [];
		t.history = convo;
		t.size = sizeOf(convo);
		t.identity = identity;
		return t;
	}

	private spawn(parent: Thread, call: Call, convo: string[], identity: string): Thread {
		const child = this.add(roleOf(call), convo, identity, parent);
		child.via = call;
		call.child = child;
		parent.children.push(child);
		this.trace.record(
			{
				kind: "spawn",
				agent: parent.role,
				span: parent.span,
				name: child.role,
				args: call.args,
				data: { child: child.span, call: call.name },
			},
			{ inferred: true },
		);
		return child;
	}

	private add(role: string, convo: string[], identity: string, parent?: Thread): Thread {
		const n = (this.roleCount.get(role) ?? 0) + 1;
		this.roleCount.set(role, n);
		const span = n === 1 ? role : `${role}#${n}`;
		const t: Thread = {
			span,
			role,
			parent,
			history: convo,
			first: this.first,
			size: sizeOf(convo),
			identity,
			pending: [],
			calls: [],
			children: [],
			reported: false,
			last: 0,
		};
		this.threads.push(t);
		if (!this.trace.spans.has(span))
			this.trace.addSpan({ id: span, role, ...(parent ? { parent: parent.span } : {}), reported: false });
		return t;
	}
}
