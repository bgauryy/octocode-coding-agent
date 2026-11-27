import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { anthropicMessages, sendAnthropicJson, sendAnthropicSse } from "./anthropic.ts";
import { Cassette, type CassetteOptions } from "./cassette.ts";
import { forwardRequest, type Wire } from "./forward.ts";
import {
	geminiMessages,
	geminiRoute,
	geminiToolNames,
	sendGeminiArray,
	sendGeminiError,
	sendGeminiJson,
	sendGeminiSse,
} from "./gemini.ts";
import type { Guard } from "./guards.ts";
import { Lineage } from "./lineage.ts";
import { sendJson, sendSse } from "./openai.ts";
import { capReason, checkCaps, costOf, recordReply, type Caps } from "./policy.ts";
import type { Reply } from "./reply.ts";
import { responsesMessages, sendResponsesJson, sendResponsesSse } from "./responses.ts";
import { StepFailure, type Responder, type Step } from "./script.ts";
import { DEFAULT_CHARS_PER_TOKEN, simulateUsage } from "./simulated-usage.ts";
import { harnessToolErrors } from "./tool-errors.ts";
import { canonicalize, hashOf, mcpToolName, Trace, type CapturedRequest, type ChatMessage } from "./trace.ts";
import type { Forward } from "./upstream.ts";

export {
	script,
	scripts,
	StepFailure,
	type ResponderContext,
	type Responder,
	type ScriptedCall,
	type ScriptOptions,
	type Step,
	type StepSource,
} from "./script.ts";

export interface GatewayOptions {
	responder?: Responder;
	/** Request and USD caps, and the price table that prices each request. */
	caps?: Caps;
	/** Judge each tool call in a reply before the harness sees it; a block drops the reply's calls (see `recordReply`). */
	guards?: readonly Guard[];
	/** Sandbox roots replaced by `<ws>` in canonical forms. */
	roots?: string[];
	/** Estimate prompt-cache reads from the shared canonical prefix (default true). */
	simulateCache?: boolean;
	/**
	 * Characters per token of scripted usage (default 4, the kit's usual estimate). Set the harness's own ratio for the
	 * model it serves when a test depends on the harness's provider counts and its own estimates agreeing.
	 */
	charsPerToken?: number;
	/** Per-run bearer token; requests without it get 401. */
	token?: string;
	/**
	 * Forward to a real upstream (non-stream; a streaming client still gets SSE) instead of the responder. A request
	 * on the upstream's own wire goes through as sent; other pairs are translated (see `forwardRequest`). The key
	 * defaults to TESTKIT_FORWARD_KEY.
	 */
	forward?: Forward;
	/**
	 * Who sent a request without an `x-testkit-agent` header. `infer` (default): the gateway follows each
	 * conversation and records the spawns, reports and compactions it implies (`Lineage`). `header`: every such
	 * request is agent `main`.
	 */
	agents?: "infer" | "header";
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
function toolNames(tools: unknown): string[] {
	if (!Array.isArray(tools)) return [];
	return tools.map((t) => {
		const o = t as { function?: { name?: string }; name?: string };
		return o.function?.name ?? o.name ?? "?";
	});
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

function sendError(
	res: ServerResponse,
	anthropic: boolean,
	e: { status: number; message?: string; retryAfterSeconds?: number },
): void {
	const message = e.message ?? `testkit: scripted error ${e.status}`;
	const body = anthropic
		? { type: "error", error: { type: "api_error", message } }
		: { error: { message, type: "testkit_error" } };
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (e.retryAfterSeconds !== undefined) headers["retry-after"] = String(e.retryAfterSeconds);
	res.writeHead(e.status, headers);
	res.end(JSON.stringify(body));
}

function header(req: IncomingMessage, name: string): string | undefined {
	const v = req.headers[name];
	return Array.isArray(v) ? v[0] : v;
}

/** Request fields that change the model's answer besides the messages and tools; volatile ids stay out. */
const VOLATILE = new Set([
	"messages",
	"system",
	"tools",
	"input",
	"instructions",
	"contents",
	"systemInstruction",
	"model",
	"stream",
	"stream_options",
	"metadata",
	"user",
	"store",
	"prompt_cache_key",
	"safety_identifier",
	"cachedContent",
	"previous_response_id",
]);

const decodingParams = (body: Record<string, unknown>): Record<string, unknown> =>
	Object.fromEntries(Object.entries(body).filter(([k]) => !VOLATILE.has(k)));

function wireOf(path: string): { wire: Wire; gem?: ReturnType<typeof geminiRoute> } | undefined {
	const gem = geminiRoute(path);
	if (gem) return { wire: "gemini", gem };
	if (path.endsWith("/messages")) return { wire: "anthropic" };
	if (path.endsWith("/responses")) return { wire: "responses" };
	if (path.endsWith("/chat/completions")) return { wire: "openai" };
	return undefined;
}

function messagesOf(wire: Wire, body: Record<string, unknown>): ChatMessage[] {
	if (wire === "gemini") return geminiMessages(body);
	if (wire === "anthropic") return anthropicMessages(body);
	if (wire === "responses") return responsesMessages(body);
	return (Array.isArray(body.messages) ? body.messages : []) as ChatMessage[];
}

function send(
	res: ServerResponse,
	wire: Wire,
	req: CapturedRequest,
	gem: ReturnType<typeof geminiRoute>,
	r: Reply,
): void {
	const model = req.model;
	if (wire === "gemini")
		(req.stream ? sendGeminiSse : gem?.streaming ? sendGeminiArray : sendGeminiJson)(res, model, r);
	else if (wire === "responses") (req.stream ? sendResponsesSse : sendResponsesJson)(res, model, r);
	else if (wire === "anthropic") (req.stream ? sendAnthropicSse : sendAnthropicJson)(res, model, r);
	else (req.stream ? sendSse : sendJson)(res, model, r);
}

/** A scripted connection drop: nothing, or a cut-off body, then the socket closes. */
function disconnect(res: ServerResponse, how: "before-reply" | "mid-stream", stream: boolean): void {
	if (how === "before-reply") return void res.socket?.destroy();
	res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
	// Destroy only once the partial body is on the wire, so the client sees headers and a cut-off body.
	res.write(stream ? 'data: {"partial":' : '{"partial":', () => setTimeout(() => res.socket?.destroy(), 20));
}

export async function startGateway(opts: GatewayOptions = {}): Promise<Gateway> {
	checkCaps(opts.caps);
	const trace = new Trace();
	if (opts.guards?.length) trace.observe("guards");
	const lineage = opts.agents === "header" ? undefined : new Lineage(trace);
	const errors: string[] = [];
	const simulate = opts.simulateCache !== false;
	const charsPerToken =
		opts.charsPerToken !== undefined && Number.isFinite(opts.charsPerToken) && opts.charsPerToken > 0
			? opts.charsPerToken
			: DEFAULT_CHARS_PER_TOKEN;
	const reportedErrors = new Set<string>();
	let callSeq = 0;
	const cassette = Cassette.open(opts.cassette, opts.forward?.baseUrl, {
		model: opts.forward?.model,
		tier: opts.forward?.api,
	});

	/** Failed tool results the harness reported in this request's history, recorded once each. */
	const recordHarnessErrors = (wire: Wire, body: Record<string, unknown>, who: { agent: string; span: string }) => {
		const mocks = [...trace.probes].filter((p) => p.startsWith("mcp:")).map((p) => p.slice(4));
		for (const e of harnessToolErrors(wire, body)) {
			if (reportedErrors.has(e.id)) continue;
			reportedErrors.add(e.id);
			// A mock server already recorded its own failures.
			if (mocks.some((m) => e.name.startsWith(mcpToolName(m, "")))) continue;
			trace.record({
				kind: "tool_error",
				...who,
				name: e.name,
				args: e.args,
				data: { reason: "harness", message: e.message },
			});
		}
	};

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		if (
			opts.token &&
			header(req, "authorization") !== `Bearer ${opts.token}` &&
			header(req, "x-api-key") !== opts.token
		)
			return json(res, 401, { error: { message: "testkit: bad token" } });
		const path = (req.url ?? "").split("?")[0];
		// Lets adapters tell a forwarding (real-model) gateway from a scripted one, to sandbox the harness by default.
		if (req.method === "GET" && path === "/testkit") return json(res, 200, { forwarding: opts.forward !== undefined });
		if (req.method === "GET" && path.endsWith("/models"))
			return json(res, 200, { object: "list", data: [{ id: "scripted", object: "model" }] });
		const route = wireOf(path);
		if (req.method !== "POST" || !route)
			return json(res, 404, { error: { message: `testkit: no route ${req.method} ${path}` } });
		const { wire, gem } = route;
		const alt = new URL(req.url ?? "", "http://x").searchParams.get("alt");

		const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
		const messages = messagesOf(wire, body);
		const named = header(req, "x-testkit-agent");
		const who = named
			? { agent: named, span: header(req, "x-testkit-span") ?? named }
			: lineage
				? lineage.assign(messages, body.tools, trace.requests.length)
				: { agent: DEFAULT_AGENT, span: DEFAULT_AGENT };
		const { agent, span } = who;
		if (!trace.spans.has(span)) trace.addSpan({ id: span, role: agent, reported: false });
		const canonical = canonicalize(
			{
				model: body.model ?? gem?.model,
				messages: messages.map(({ blocks: _blocks, ...m }) => m),
				tools: body.tools ?? [],
			},
			{ roots: opts.roots },
		);
		const captured: CapturedRequest = {
			index: trace.requests.length,
			agent,
			span,
			model: gem?.model ?? (typeof body.model === "string" ? body.model : ""),
			stream: gem ? gem.streaming && alt === "sse" : body.stream === true,
			messages,
			tools: gem ? geminiToolNames(body.tools) : toolNames(body.tools),
			raw: body,
			canonical,
			hash: hashOf(canonical),
			bytes: Buffer.byteLength(canonical),
		};
		trace.requests.push(captured);
		recordHarnessErrors(wire, body, who);
		const turn = trace.requests.filter((r) => r.agent === agent).length - 1;

		const fail = (e: { status: number; message?: string; retryAfterSeconds?: number }): void =>
			wire === "gemini" ? sendGeminiError(res, e) : sendError(res, wire === "anthropic", e);
		// Sampling and tool-choice settings change the answer, so a replay must match them too.
		const cassetteKey = cassette?.key(
			hashOf(`${canonical}\n${canonicalize(decodingParams(body), { roots: opts.roots })}`),
		);
		let reply: Reply;
		let replayed = false;
		/** A cut request reached no model, so it costs nothing. */
		let cut = false;
		try {
			const plan = cassette?.plan(cassetteKey!);
			const capped = capReason(opts.caps, trace, captured);
			if (plan?.action === "replay") {
				reply = plan.reply;
				replayed = true;
			} else if (capped) {
				trace.cut = true;
				cut = true;
				trace.record({ kind: "cut", agent, span, data: capped.data });
				reply = {
					text: capped.text,
					toolCalls: [],
					usage: simulateUsage(trace, captured, body.tools, capped.text, charsPerToken),
				};
			} else {
				const t0 = performance.now();
				if (opts.forward) {
					reply = await forwardRequest(wire, body, opts.forward, {
						model: captured.model,
						headers: {
							"anthropic-version": header(req, "anthropic-version"),
							"anthropic-beta": header(req, "anthropic-beta"),
						},
					});
				} else {
					const responder: Responder = opts.responder ?? (() => ({ text: "ok" }));
					const step: Step = await responder({ request: captured, trace, turn });
					if ("error" in step) return fail(step.error);
					if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
					if (step.disconnect) return disconnect(res, step.disconnect, captured.stream);
					const toolCalls = (step.toolCalls ?? []).map((c) => ({
						id: `call_${++callSeq}`,
						name: c.name,
						arguments: c.rawArgs ?? JSON.stringify(c.args ?? {}),
					}));
					const text = step.text ?? "";
					reply = {
						text,
						toolCalls,
						usage: { ...simulateUsage(trace, captured, body.tools, text, charsPerToken), ...step.usage },
						...(step.stop ? { stop: step.stop } : {}),
					};
				}
				cassette?.record(cassetteKey!, reply, performance.now() - t0);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			errors.push(msg);
			return fail({ status: e instanceof StepFailure ? e.status : 502, message: msg });
		}

		const real = opts.forward !== undefined || replayed;
		if (simulate || real) captured.usage = reply.usage;
		if (!simulate && !real) delete captured.usage;
		if (opts.caps?.pricing && captured.usage && !cut) captured.costUsd = costOf(captured.usage, opts.caps.pricing);
		reply = recordReply(trace, who, reply, opts.guards);
		lineage?.settle(span, reply);
		// A unique id per reply: some clients (LangGraph) merge messages that share one.
		send(res, wire, captured, gem, { ...reply, id: String(captured.index) });
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
