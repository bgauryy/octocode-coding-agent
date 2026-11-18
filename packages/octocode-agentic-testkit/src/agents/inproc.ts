import type { MemoryStore } from "../memory.ts";
import type { McpClient } from "../mcp.ts";
import type { ChatMessage, ToolCall, Trace } from "../trace.ts";

export interface Skill {
	name: string;
	description: string;
	body: string;
}

export interface InprocOptions {
	/** Gateway origin (`Gateway.url`). */
	gatewayUrl: string;
	trace: Trace;
	role?: string;
	model?: string;
	mcp?: McpClient[];
	skills?: Skill[];
	/** Long-term memory behind `memory_read` / `memory_write`; short memory is the message history. */
	memory?: MemoryStore;
	maxTurns?: number;
	/** Turn budget of spawned children; a child that does not answer in time never reports (orphan). */
	childMaxTurns?: number;
	/** Compact when the history is larger than this many bytes. */
	compactAt?: number;
	/** Demo of a broken cache: the system prompt changes every request. */
	unstableSystem?: boolean;
	stream?: boolean;
	systemPrompt?: string;
	/** Extra fields merged into every chat request body (for example `reasoning_effort` for an upstream model). */
	body?: Record<string, unknown>;
	/** Extra headers for the gateway (token). */
	headers?: Record<string, string>;
}

export interface InprocResult {
	/** Final answer; null when maxTurns ended the loop first. */
	answer: string | null;
	messages: ChatMessage[];
}

interface LocalTool {
	def: { name: string; description: string; parameters: Record<string, unknown> };
	run(args: Record<string, unknown>): Promise<string> | string;
}

const str = { type: "string" };
const schema = (props: Record<string, unknown>) => ({
	type: "object",
	properties: props,
	required: Object.keys(props),
});

/** Runs one user turn; with `prior` (an earlier result's `messages`) the turn continues that conversation. */
export async function runInproc(opts: InprocOptions, prompt: string, prior?: ChatMessage[]): Promise<InprocResult> {
	opts.trace.observe("events");
	const counters = { spans: 0, system: 0 };
	return loop(opts, prompt, opts.role ?? "main", undefined, counters, 0, prior);
}

interface Counters {
	spans: number;
	system: number;
}

function systemText(opts: InprocOptions, role: string, nonce?: number): string {
	const skills = (opts.skills ?? []).map((s) => `- ${s.name}: ${s.description}`).join("\n");
	return [
		opts.systemPrompt ?? `You are the ${role} agent. Use tools when they help; answer when done.`,
		skills ? `Skills (call load_skill to read one):\n${skills}` : "",
		nonce === undefined ? "" : `Clock tick: ${nonce}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

async function loop(
	opts: InprocOptions,
	prompt: string,
	role: string,
	parent: string | undefined,
	counters: Counters,
	depth: number,
	prior: ChatMessage[] = [],
): Promise<InprocResult> {
	const { trace } = opts;
	const spanId = parent === undefined ? role : `${role}#${++counters.spans}`;
	trace.addSpan({ id: spanId, role, parent, reported: false });
	const mcpTools = new Map<string, McpClient>();
	const defs: { name: string; description: string; parameters: unknown }[] = [];
	for (const c of opts.mcp ?? []) {
		// oxlint-disable-next-line no-await-in-loop -- one MCP server at a time, so MCP requests keep a fixed order
		for (const t of await c.listTools()) {
			mcpTools.set(t.name, c);
			defs.push({ name: t.name, description: t.description, parameters: t.inputSchema });
		}
	}
	const local = new Map<string, LocalTool>();
	const addLocal = (t: LocalTool): void => void local.set(t.def.name, t);
	const log = (
		kind: "skill_load" | "memory_read" | "memory_write" | "tool_exec" | "tool_error",
		name: string,
		args: unknown,
		data?: unknown,
	): void => void trace.record({ kind, agent: role, span: spanId, name, args, data });

	if (opts.skills?.length)
		addLocal({
			def: {
				name: "load_skill",
				description: "Read the full instructions of a skill.",
				parameters: schema({ name: str }),
			},
			run: (a) => {
				const s = opts.skills!.find((k) => k.name === a.name);
				if (!s) {
					log("tool_error", "load_skill", a, "unknown-skill");
					return `unknown skill ${String(a.name)}`;
				}
				log("skill_load", s.name, a);
				return s.body;
			},
		});
	if (opts.memory) {
		const mem = opts.memory;
		addLocal({
			def: { name: "memory_read", description: "Read a long-term memory entry.", parameters: schema({ key: str }) },
			run: (a) => {
				const v = mem.read(String(a.key));
				log("memory_read", String(a.key), a, v);
				return v ?? "(empty)";
			},
		});
		addLocal({
			def: {
				name: "memory_write",
				description: "Store a long-term memory entry.",
				parameters: schema({ key: str, value: str }),
			},
			run: (a) => {
				mem.write(String(a.key), String(a.value));
				log("memory_write", String(a.key), a);
				return "stored";
			},
		});
	}
	if (depth === 0)
		addLocal({
			def: {
				name: "spawn_agent",
				description: "Delegate a task to a child agent and get its report.",
				parameters: schema({ role: str, task: str }),
			},
			run: async (a) => {
				const childRole = String(a.role);
				const before = counters.spans;
				const childSpan = `${childRole}#${before + 1}`;
				trace.record({
					kind: "spawn",
					agent: role,
					span: spanId,
					name: childRole,
					args: a,
					data: { child: childSpan },
				});
				const res = await loop(
					{ ...opts, maxTurns: opts.childMaxTurns ?? 4 },
					String(a.task),
					childRole,
					spanId,
					counters,
					depth + 1,
				);
				return res.answer ?? "child produced no report";
			},
		});
	for (const t of local.values())
		defs.push({ name: t.def.name, description: t.def.description, parameters: t.def.parameters });

	const messages: ChatMessage[] = [
		...(prior.length ? prior : [{ role: "system" as const, content: systemText(opts, role) }]),
		{ role: "user", content: prompt },
	];
	const post = async (agent: string, msgs: ChatMessage[], withTools: boolean) => {
		const r = await fetch(`${opts.gatewayUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-testkit-agent": agent,
				"x-testkit-span": spanId,
				...opts.headers,
			},
			body: JSON.stringify({
				model: opts.model ?? "scripted",
				messages: msgs,
				stream: false,
				...opts.body,
				...(withTools && defs.length ? { tools: defs.map((d) => ({ type: "function", function: d })) } : {}),
			}),
		});
		if (!r.ok) throw new Error(`gateway ${r.status}: ${await r.text()}`);
		const data = (await r.json()) as {
			choices: { message: { content?: string | null; tool_calls?: ToolCall[] } }[];
		};
		return data.choices[0].message;
	};

	let compactions = 0;
	for (let turn = 0; turn < (opts.maxTurns ?? 10); turn++) {
		if (
			opts.compactAt !== undefined &&
			compactions < 3 &&
			Buffer.byteLength(JSON.stringify(messages)) > opts.compactAt
		) {
			const from = Buffer.byteLength(JSON.stringify(messages));
			// oxlint-disable-next-line no-await-in-loop -- agent loop: each model call needs the previous step's messages
			const summary = await post(
				`${role}:compactor`,
				[
					{ role: "system", content: "Summarize the conversation so far in a few lines." },
					{ role: "user", content: JSON.stringify(messages.slice(1)) },
				],
				false,
			);
			messages.splice(1, messages.length - 1, {
				role: "user",
				content: `Summary of earlier work:\n${summary.content ?? ""}`,
			});
			compactions++;
			trace.record({
				kind: "compaction",
				agent: role,
				span: spanId,
				data: { from, to: Buffer.byteLength(JSON.stringify(messages)) },
			});
		}
		if (opts.unstableSystem)
			messages[0] = { role: "system", content: systemText(opts, role, ++counters.system + Date.now()) };
		// oxlint-disable-next-line no-await-in-loop -- agent loop: each model call needs the previous step's messages
		const msg = await post(role, messages, true);
		if (!msg.tool_calls?.length) {
			const answer = msg.content ?? "";
			messages.push({ role: "assistant", content: answer });
			if (parent !== undefined) {
				trace.record({ kind: "report", agent: role, span: spanId, name: parent, data: answer });
				trace.spans.get(spanId)!.reported = true;
			}
			return { answer, messages };
		}
		messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
		for (const call of msg.tool_calls) {
			let out: string;
			try {
				const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
				const name = call.function.name;
				const remote = mcpTools.get(name);
				if (remote) {
					// oxlint-disable-next-line no-await-in-loop -- tool calls run in the order the model sent them, so their side effects and trace events keep that order
					const r = await remote.callTool(name, args);
					out = r.isError ? `Error: ${r.text}` : r.text;
				} else if (local.has(name)) {
					log("tool_exec", name, args);
					// oxlint-disable-next-line no-await-in-loop -- tool calls run in the order the model sent them, so their side effects and trace events keep that order
					out = await local.get(name)!.run(args);
				} else {
					log("tool_error", name, args, "unknown-tool");
					out = `Error: unknown tool ${name}`;
				}
			} catch (e) {
				out = `Error: ${e instanceof Error ? e.message : String(e)}`;
			}
			messages.push({ role: "tool", tool_call_id: call.id, content: out });
		}
	}
	return { answer: null, messages };
}
