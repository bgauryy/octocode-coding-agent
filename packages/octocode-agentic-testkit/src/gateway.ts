import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
	anthropicMessages,
	fromAnthropicResponse,
	sendAnthropicJson,
	sendAnthropicSse,
	toAnthropicRequest,
} from "./anthropic.ts";
import { Cassette, type CassetteOptions } from "./cassette.ts";
import { responsesMessages, responsesToChatBody, sendResponsesSse } from "./responses.ts";
import { forwardUpstream, type Forward } from "./upstream.ts";
import type { Reply } from "./reply.ts";
import { canonicalize, hashOf, Trace, type CapturedRequest, type ChatMessage, type Usage } from "./trace.ts";

export type Step = { text: string } | { toolCalls: { name: string; args: unknown }[] };

export interface ResponderContext {
	request: CapturedRequest;
	trace: Trace;
	/** 0-based position among this agent's requests. */
	turn: number;
}

export type StepSource = Step | ((ctx: ResponderContext) => Step);
export type Responder = (ctx: ResponderContext) => Step | Promise<Step>;

export interface GatewayOptions {
	responder?: Responder;
	caps?: { maxRequests?: number };
	/** Sandbox roots replaced by `<ws>` in canonical forms. */
	roots?: string[];
	/** Estimate prompt-cache reads from the shared canonical prefix (default true). */
	simulateCache?: boolean;
	/** Per-run bearer token; requests without it get 401. */
	token?: string;
	/**
	 * Forward to a real upstream (non-stream; a streaming client still gets SSE) instead of the responder.
	 * `api: "anthropic"` posts `{baseUrl}/v1/messages` with `x-api-key`; the key defaults to TESTKIT_FORWARD_KEY.
	 */
	forward?: Forward;
	/**
	 * Run cache for real-upstream runs. With `forward` set it is on by default (`auto`: replay a hit, record a miss);
	 * without `forward` only an explicit option turns it on. A replay miss fails the request and lands in `errors`.
	 */
	cassette?: CassetteOptions;
}

export interface Gateway {
	/** Origin without path, e.g. http://127.0.0.1:41234; agents use `${url}/v1`. */
	url: string;
	trace: Trace;
	/** Responder or upstream failures (the client got a 5xx). */
	errors: string[];
	close(): Promise<void>;
}

const DEFAULT_AGENT = "main";
const est = (chars: number): number => Math.ceil(chars / 4);

/** Per-agent sequential steps; the last step repeats. A step may be a function of the request. */
export function script(steps: StepSource[]): Responder {
	return (ctx) => {
		const s = steps[Math.min(ctx.turn, steps.length - 1)];
		if (s === undefined) return { text: "testkit: empty script" };
		return typeof s === "function" ? s(ctx) : s;
	};
}

/** One script per agent role; `<role>:compactor` falls back to a canned summary, other unknown roles to a notice. */
export function scripts(byAgent: Record<string, StepSource[]>): Responder {
	const built = new Map(Object.entries(byAgent).map(([k, v]) => [k, script(v)]));
	return (ctx) => {
		const r = built.get(ctx.request.agent);
		if (r) return r(ctx);
		if (ctx.request.agent.endsWith(":compactor")) return { text: "Summary of the earlier work." };
		return { text: `testkit: no script for agent ${ctx.request.agent}` };
	};
}

function toolNames(tools: unknown): string[] {
	if (!Array.isArray(tools)) return [];
	return tools.map((t) => {
		const o = t as { function?: { name?: string }; name?: string };
		return o.function?.name ?? o.name ?? "?";
	});
}

function simulateUsage(trace: Trace, req: CapturedRequest, rawTools: unknown, completion: string): Usage {
	// Unmasked, like a provider cache: a changing timestamp in the prefix is a cache miss.
	const raw = { raw: true };
	const toolsCanon = canonicalize(rawTools ?? [], raw);
	const canon = req.messages.map((m) => canonicalize(m, raw));
	const total = toolsCanon.length + canon.reduce((n, c) => n + c.length, 0);
	let best = 0;
	for (const prev of trace.requests) {
		if (prev === req || prev.index >= req.index || prev.agent !== req.agent || prev.model !== req.model) continue;
		if (canonicalize((prev.raw as { tools?: unknown }).tools ?? [], raw) !== toolsCanon) continue;
		let chars = 0;
		for (let k = 0; k < prev.messages.length && k < canon.length; k++) {
			if (canonicalize(prev.messages[k], raw) !== canon[k]) break;
			chars += canon[k].length;
		}
		best = Math.max(best, chars > 0 ? chars + toolsCanon.length : 0);
	}
	return {
		promptTokens: est(total),
		cachedTokens: est(best),
		completionTokens: est(completion.length),
		estimated: true,
	};
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function openAiUsage(u: Usage): unknown {
	return {
		prompt_tokens: u.promptTokens,
		completion_tokens: u.completionTokens,
		total_tokens: u.promptTokens + u.completionTokens,
		prompt_tokens_details: { cached_tokens: u.cachedTokens },
	};
}

function sendJson(res: ServerResponse, model: string, reply: Reply): void {
	json(res, 200, {
		id: "chatcmpl-testkit",
		object: "chat.completion",
		created: 0,
		model,
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: reply.toolCalls.length ? null : reply.text,
					...(reply.toolCalls.length
						? {
								tool_calls: reply.toolCalls.map((c) => ({
									id: c.id,
									type: "function",
									function: { name: c.name, arguments: c.arguments },
								})),
							}
						: {}),
				},
				finish_reason: reply.toolCalls.length ? "tool_calls" : "stop",
			},
		],
		usage: openAiUsage(reply.usage),
	});
}

function sendSse(res: ServerResponse, model: string, reply: Reply): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (choices: unknown[], extra: Record<string, unknown> = {}): void => {
		res.write(
			`data: ${JSON.stringify({ id: "chatcmpl-testkit", object: "chat.completion.chunk", created: 0, model, choices, ...extra })}\n\n`,
		);
	};
	chunk([{ index: 0, delta: { role: "assistant", content: reply.toolCalls.length ? null : "" }, finish_reason: null }]);
	if (reply.toolCalls.length) {
		reply.toolCalls.forEach((c, i) => {
			const head = { index: i, id: c.id, type: "function", function: { name: c.name, arguments: "" } };
			chunk([{ index: 0, delta: { tool_calls: [head] }, finish_reason: null }]);
			const half = Math.ceil(c.arguments.length / 2);
			for (const part of [c.arguments.slice(0, half), c.arguments.slice(half)]) {
				if (!part) continue;
				chunk([
					{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: part } }] }, finish_reason: null },
				]);
			}
		});
	} else {
		for (let i = 0; i < reply.text.length; i += 24)
			chunk([{ index: 0, delta: { content: reply.text.slice(i, i + 24) }, finish_reason: null }]);
	}
	chunk([{ index: 0, delta: {}, finish_reason: reply.toolCalls.length ? "tool_calls" : "stop" }]);
	chunk([], { usage: openAiUsage(reply.usage) });
	res.write("data: [DONE]\n\n");
	res.end();
}

function header(req: IncomingMessage, name: string): string | undefined {
	const v = req.headers[name];
	return Array.isArray(v) ? v[0] : v;
}

export async function startGateway(opts: GatewayOptions = {}): Promise<Gateway> {
	const trace = new Trace();
	const errors: string[] = [];
	const simulate = opts.simulateCache !== false;
	let callSeq = 0;
	const cassette = Cassette.open(opts.cassette, opts.forward?.baseUrl, {
		model: opts.forward?.model,
		tier: opts.forward?.api,
	});

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		if (
			opts.token &&
			header(req, "authorization") !== `Bearer ${opts.token}` &&
			header(req, "x-api-key") !== opts.token
		)
			return json(res, 401, { error: { message: "testkit: bad token" } });
		const path = (req.url ?? "").split("?")[0];
		if (req.method === "GET" && path.endsWith("/models"))
			return json(res, 200, { object: "list", data: [{ id: "scripted", object: "model" }] });
		const anthropic = path.endsWith("/messages");
		const responses = path.endsWith("/responses");
		if (req.method !== "POST" || !(anthropic || responses || path.endsWith("/chat/completions")))
			return json(res, 404, { error: { message: `testkit: no route ${req.method} ${path}` } });

		const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
		const agent = header(req, "x-testkit-agent") ?? DEFAULT_AGENT;
		const span = header(req, "x-testkit-span") ?? agent;
		if (!trace.spans.has(span)) trace.addSpan({ id: span, role: agent, reported: false });
		const messages = anthropic
			? anthropicMessages(body)
			: responses
				? responsesMessages(body)
				: ((Array.isArray(body.messages) ? body.messages : []) as ChatMessage[]);
		const canonical = canonicalize({ model: body.model, messages, tools: body.tools ?? [] }, { roots: opts.roots });
		const captured: CapturedRequest = {
			index: trace.requests.length,
			agent,
			span,
			model: typeof body.model === "string" ? body.model : "",
			stream: body.stream === true,
			messages,
			tools: toolNames(body.tools),
			raw: body,
			canonical,
			hash: hashOf(canonical),
			bytes: Buffer.byteLength(canonical),
		};
		trace.requests.push(captured);
		const turn = trace.requests.filter((r) => r.agent === agent).length - 1;

		const cassetteKey = cassette?.key(captured.hash);
		let reply: Reply;
		let replayed = false;
		try {
			const plan = cassette?.plan(cassetteKey!);
			const max = opts.caps?.maxRequests;
			if (plan?.action === "replay") {
				reply = plan.reply;
				replayed = true;
			} else if (max !== undefined && captured.index >= max) {
				trace.cut = true;
				trace.record({ kind: "cut", agent, span, data: `request cap ${max}` });
				reply = {
					text: "testkit: request cap",
					toolCalls: [],
					usage: simulateUsage(trace, captured, body.tools, "testkit: request cap"),
				};
			} else {
				const t0 = performance.now();
				if (opts.forward) {
					reply = await forwardUpstream(responses ? responsesToChatBody(body) : body, opts.forward);
				} else {
					const step = await (opts.responder ?? (() => ({ text: "ok" })))({ request: captured, trace, turn });
					const toolCalls =
						"toolCalls" in step
							? step.toolCalls.map((c) => ({
									id: `call_${++callSeq}`,
									name: c.name,
									arguments: JSON.stringify(c.args ?? {}),
								}))
							: [];
					const text = "text" in step ? step.text : "";
					reply = { text, toolCalls, usage: simulateUsage(trace, captured, body.tools, text) };
				}
				cassette?.record(cassetteKey!, reply, performance.now() - t0);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			errors.push(msg);
			return json(res, 502, { error: { message: msg } });
		}

		const real = opts.forward !== undefined || replayed;
		if (simulate || real) captured.usage = reply.usage;
		if (!simulate && !real) delete captured.usage;
		for (const c of reply.toolCalls) {
			let args: unknown = c.arguments;
			try {
				args = JSON.parse(c.arguments);
			} catch {
				// keep the raw string so malformed arguments stay visible
			}
			trace.record({ kind: "model_tool_call", agent, span, name: c.name, args });
		}
		if (!reply.toolCalls.length) trace.record({ kind: "answer", agent, span, data: reply.text });

		const model = captured.model;
		if (responses) sendResponsesSse(res, model, reply);
		else if (anthropic) (captured.stream ? sendAnthropicSse : sendAnthropicJson)(res, model, reply);
		else if (captured.stream) sendSse(res, model, reply);
		else sendJson(res, model, reply);
	};

	const server = createServer((req, res) => {
		handle(req, res).catch((e) => {
			errors.push(e instanceof Error ? e.message : String(e));
			if (!res.headersSent) json(res, 500, { error: { message: String(e) } });
			else res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		trace,
		errors,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
