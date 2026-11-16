import { expect } from "vitest";
import { cacheReadRatio, duplicateBlocks, growth, prefixBreaks } from "./context.ts";
import { canonicalize, type Trace, type TraceEvent } from "./trace.ts";

interface Result {
	pass: boolean;
	message: () => string;
}

export interface CalledOptions {
	/** Partial match: every given key must equal (deeply) the call's argument. */
	args?: Record<string, unknown>;
	/** `'answer'` or a tool name: the call must happen before it. */
	before?: string;
	times?: number;
}

export interface TestkitMatchers<R = unknown> {
	toHaveCalledTool(name: string, opts?: CalledOptions): R;
	toHaveCalledMcp(server: string, tool: string, opts?: CalledOptions): R;
	toHaveLoadedSkill(name: string): R;
	/** `raw` (default true) compares text without date/id masking; `raw: false` masks them. */
	toKeepStablePrefix(opts?: { allowAfterCompaction?: boolean; raw?: boolean }): R;
	toHaveNoDuplicateBlocks(opts?: { minChars?: number }): R;
	toGrowAtMost(bytesPerTurn: number): R;
	toHaveCacheReadRatio(opts: { min: number }): R;
	toNotRetryIdentically(tool: string): R;
	toReflect(opts: { after: "error" }): R;
	toHaveSpawned(role: string, opts?: { times?: number }): R;
	toHaveNoOrphanAgents(): R;
	toHaveHandedOff(from: string, to: string): R;
	toHaveRecalledBefore(key: string, tool: string): R;
	toHaveCompacted(): R;
}

declare module "vitest" {
	// T is unused here but must stay: vitest declares Matchers<R, T>.
	interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> extends TestkitMatchers<R> {}
}

const fail = (message: string): Result => ({ pass: false, message: () => message });
/**
 * Throws instead of returning `pass: false`: under `.not` a failed result would turn into a silent pass,
 * and "no data" must never count as evidence either way.
 */
const cannot = (what: string): never => {
	throw new Error(`cannot observe: ${what}`);
};

function asTrace(v: unknown): Trace | undefined {
	const t = v as Partial<Trace> | null;
	return t && Array.isArray(t.requests) && Array.isArray(t.events) ? (v as Trace) : undefined;
}

function subset(actual: unknown, want: unknown): boolean {
	if (want && typeof want === "object" && !Array.isArray(want)) {
		if (!actual || typeof actual !== "object") return false;
		return Object.entries(want).every(([k, v]) => subset((actual as Record<string, unknown>)[k], v));
	}
	return canonicalize(actual) === canonicalize(want);
}

const describeArgs = (e: TraceEvent): string => `#${e.seq} ${e.name}(${JSON.stringify(e.args)})`;

/** Matching calls: the model's tool calls (gateway) and, for MCP, the server-side executions. */
function calls(
	t: Trace,
	kind: "model_tool_call" | "tool_exec",
	name: string,
	o: CalledOptions,
	server?: string,
): TraceEvent[] {
	return t.events.filter(
		(e) =>
			e.kind === kind &&
			e.name === name &&
			(server === undefined || e.server === server) &&
			(o.args === undefined || subset(e.args, o.args)),
	);
}

function checkCalled(t: Trace, found: TraceEvent[], label: string, o: CalledOptions): Result {
	const all = t.events.filter((e) => e.kind === "model_tool_call" || e.kind === "tool_exec").map(describeArgs);
	const seen = `\n  calls seen: ${all.join(" | ") || "none"}`;
	if (o.times !== undefined) {
		return {
			pass: found.length === o.times,
			message: () => `expected ${label} ${o.times} time(s), saw ${found.length}${seen}`,
		};
	}
	if (!found.length)
		return fail(`expected ${label} to be called${o.args ? ` with ${JSON.stringify(o.args)}` : ""}${seen}`);
	if (o.before !== undefined) {
		const limit =
			o.before === "answer"
				? t.events.filter((e) => e.kind === "answer").at(-1)
				: t.events.find((e) => (e.kind === "model_tool_call" || e.kind === "tool_exec") && e.name === o.before);
		if (!limit) return cannot(`no ${o.before === "answer" ? "answer" : `call of ${o.before}`} in the trace`);
		const ok = found.some((e) => e.seq < limit.seq);
		return {
			pass: ok,
			message: () =>
				`expected ${label} before ${o.before} (event #${limit.seq}); first call was event #${found[0].seq}${seen}`,
		};
	}
	return { pass: true, message: () => `expected ${label} not to be called, saw ${found.length} call(s)${seen}` };
}

function needTrace(v: unknown): Trace {
	const t = asTrace(v) ?? cannot("received value is not a Trace");
	if (!t.requests.length && !t.events.length) cannot("empty trace (no requests, no events)");
	return t;
}

/** `mcp__<server>__<tool>` as agents namespace MCP tools; server characters outside [A-Za-z0-9_] become `_`. */
const namespacedName = (server: string, tool: string): string =>
	`mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__${tool}`;

/** Whether a name (raw, or namespaced by an agent) refers to the tool of a server-side event. */
const sameTool = (name: string | undefined, ev: TraceEvent): boolean =>
	name !== undefined &&
	ev.name !== undefined &&
	(name === ev.name || (ev.server !== undefined && name === namespacedName(ev.server, ev.name)));

export const matchers = {
	toHaveCalledTool(received: unknown, name: string, o: CalledOptions = {}): Result {
		const t = needTrace(received);
		return checkCalled(t, calls(t, "model_tool_call", name, o), `tool ${name}`, o);
	},

	toHaveCalledMcp(received: unknown, server: string, tool: string, o: CalledOptions = {}): Result {
		const t = needTrace(received);
		if (!t.events.some((e) => e.server === server))
			return cannot(`no events from MCP server ${server} (is the mock sharing this trace?)`);
		return checkCalled(t, calls(t, "tool_exec", tool, o, server), `mcp ${server}.${tool}`, o);
	},

	toHaveLoadedSkill(received: unknown, name: string): Result {
		const t = needTrace(received);
		if (!t.events.length) return cannot("no events");
		const hit = t.events.find((e) => {
			if (e.kind === "skill_load") return e.name === name;
			if (e.kind !== "model_tool_call") return false;
			const a = (e.args ?? {}) as Record<string, unknown>;
			if (e.name === "skill") return a.name === name;
			if (e.name === "read" || e.name === "bash")
				return Object.values(a).some((v) => typeof v === "string" && v.includes("SKILL.md") && v.includes(name));
			return false;
		});
		return {
			pass: hit !== undefined,
			message: () =>
				hit
					? `expected skill ${name} not to load (event #${hit.seq})`
					: `expected skill ${name} to load; no skill_load, skill call or SKILL.md read found`,
		};
	},

	toKeepStablePrefix(received: unknown, o: { allowAfterCompaction?: boolean; raw?: boolean } = {}): Result {
		const t = needTrace(received);
		if (t.requests.length < 2) return cannot("need at least two requests");
		const breaks = prefixBreaks(t, o);
		return {
			pass: breaks.length === 0,
			message: () =>
				breaks.length
					? `prefix not stable: ${breaks.map((b) => `request ${b.request} (${b.agent}) ${b.reason} at message ${b.messageIndex}`).join("; ")}`
					: "expected the prefix to break, but it was stable",
		};
	},

	toHaveNoDuplicateBlocks(received: unknown, o: { minChars?: number } = {}): Result {
		const t = needTrace(received);
		if (!t.requests.length) return cannot("no requests");
		const dups = duplicateBlocks(t, o.minChars);
		return {
			pass: dups.length === 0,
			message: () =>
				dups.length
					? `duplicate blocks: ${dups.map((d) => `request ${d.request} x${d.count} "${d.preview}"`).join("; ")}`
					: "expected duplicate blocks, found none",
		};
	},

	toGrowAtMost(received: unknown, bytesPerTurn: number): Result {
		const t = needTrace(received);
		const agents = [...new Set(t.requests.map((r) => r.agent))];
		let compared = 0;
		for (const a of agents) {
			const reqs = t.requests.filter((r) => r.agent === a);
			const sizes = growth(t, a);
			for (let i = 1; i < sizes.length; i++) {
				compared++;
				const delta = sizes[i] - sizes[i - 1];
				if (delta > bytesPerTurn)
					return fail(
						`request ${reqs[i].index} (${a}) grew ${delta} bytes over the previous one, limit ${bytesPerTurn}`,
					);
			}
		}
		if (!compared) return cannot("need two requests of one agent");
		return { pass: true, message: () => `expected growth above ${bytesPerTurn} bytes per turn` };
	},

	toHaveCacheReadRatio(received: unknown, o: { min: number }): Result {
		const t = needTrace(received);
		if (!t.requests.some((r) => r.usage)) return cannot("no usage on any request");
		const ratio = cacheReadRatio(t);
		return {
			pass: ratio >= o.min,
			message: () =>
				`cache read ratio ${ratio.toFixed(3)} (${t.requests.some((r) => r.usage?.estimated) ? "estimated" : "reported"}), min ${o.min}`,
		};
	},

	toNotRetryIdentically(received: unknown, tool: string): Result {
		const t = needTrace(received);
		const errors = t.events.filter((e) => e.kind === "tool_error" && (e.name === tool || sameTool(tool, e)));
		const modelCalls = t.events.filter((e) => e.kind === "model_tool_call");
		if (!errors.length) return cannot(`no tool_error for ${tool} in the trace`);
		if (!modelCalls.length) return cannot(`no model tool calls in the trace (is the gateway sharing this trace?)`);
		for (const err of errors) {
			const mine = (e: TraceEvent): boolean =>
				e.kind === "model_tool_call" && (e.name === err.name || sameTool(e.name, err));
			const before = modelCalls.filter((e) => e.seq < err.seq && mine(e)).at(-1);
			if (!before) return cannot(`no model call of ${tool} before tool_error #${err.seq}`);
			const after = modelCalls.find((e) => e.seq > err.seq && mine(e));
			if (after && canonicalize(before.args) === canonicalize(after.args))
				return fail(
					`${tool} retried with identical args after error (events #${before.seq} then #${after.seq}): ${JSON.stringify(after.args)}`,
				);
		}
		return { pass: true, message: () => `expected ${tool} to be retried identically after an error` };
	},

	toReflect(received: unknown, _o: { after: "error" }): Result {
		const t = needTrace(received);
		const errors = t.events.filter((e) => e.kind === "tool_error");
		if (!errors.length) return cannot("no tool_error in the trace");
		for (const err of errors) {
			const next = t.events.find(
				(e) => e.seq > err.seq && e.agent === err.agent && (e.kind === "model_tool_call" || e.kind === "answer"),
			);
			if (!next) {
				if (t.cut) continue;
				return cannot(`no model action after tool_error #${err.seq}`);
			}
			if (next.kind === "answer")
				return fail(
					`model answered (event #${next.seq}) right after tool_error #${err.seq} (${err.name}) without another tool call`,
				);
		}
		return { pass: true, message: () => "expected the model to answer right after a tool error" };
	},

	toHaveSpawned(received: unknown, role: string, o: { times?: number } = {}): Result {
		const t = needTrace(received);
		if (!t.events.some((e) => e.kind === "spawn") && !t.spans.size) return cannot("no spawn events and no spans");
		const n = t.events.filter((e) => e.kind === "spawn" && e.name === role).length;
		return {
			pass: o.times === undefined ? n > 0 : n === o.times,
			message: () => `expected ${role} spawned ${o.times ?? "at least once"}, saw ${n}`,
		};
	},

	toHaveNoOrphanAgents(received: unknown): Result {
		const t = needTrace(received);
		if (![...t.spans.values()].some((s) => s.parent !== undefined))
			return cannot("no child spans (nothing was spawned)");
		const orphans = [...t.spans.values()].filter((s) => s.parent !== undefined && !s.reported);
		return {
			pass: orphans.length === 0,
			message: () =>
				orphans.length
					? `orphan agents (never reported): ${orphans.map((s) => s.id).join(", ")}`
					: "expected orphan agents, found none",
		};
	},

	toHaveHandedOff(received: unknown, from: string, to: string): Result {
		const t = needTrace(received);
		if (!t.events.some((e) => e.kind === "spawn")) return cannot("no spawn events");
		const spawn = t.events.find((e) => e.kind === "spawn" && e.agent === from && e.name === to);
		const report = t.events.find((e) => e.kind === "report" && e.agent === to && e.name === from);
		return {
			pass: !!spawn && !!report,
			message: () =>
				spawn
					? report
						? `expected no handoff ${from} -> ${to}`
						: `${from} spawned ${to} (event #${spawn.seq}) but ${to} never reported back`
					: `${from} never spawned ${to}`,
		};
	},

	toHaveRecalledBefore(received: unknown, key: string, tool: string): Result {
		const t = needTrace(received);
		if (!t.events.some((e) => e.kind === "memory_read" || e.kind === "memory_write")) return cannot("no memory events");
		const read = t.events.find((e) => e.kind === "memory_read" && e.name === key);
		const act = t.events.find((e) => (e.kind === "model_tool_call" || e.kind === "tool_exec") && e.name === tool);
		if (!act) return cannot(`${tool} was never called`);
		return {
			pass: !!read && read.seq < act.seq,
			message: () =>
				read
					? `memory ${key} read at #${read.seq}, but ${tool} ran at #${act.seq}`
					: `memory ${key} was never read before ${tool} (#${act.seq})`,
		};
	},

	toHaveCompacted(received: unknown): Result {
		const t = needTrace(received);
		const c = t.events.filter((e) => e.kind === "compaction");
		return {
			pass: c.length > 0,
			message: () => (c.length ? `expected no compaction, saw ${c.length}` : "expected a compaction event, saw none"),
		};
	},
};

expect.extend(matchers);
