import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { octocodecodeAdapter } from "../../src/adapters/octocodecode/index.ts";

/** One provider as the probe runs it: the upstream base URL, the API, one model entry copied from a `models.json`. */
export interface ProbeProvider {
	/** Provider id written into the temp HOME's `models.json` (keep the user's id so model data resolves alike). */
	id: string;
	api: string;
	upstreamBase: string;
	/** The model entry (no credentials): `id` plus any `compat`, `promptCache`, limits. */
	model: Record<string, unknown> & { id: string };
	/** The key, held in memory and passed to the agent only through the `PROBE_API_KEY` environment variable. */
	key: string;
}

/** What one request carried and what the provider reported for it. */
export interface ProbeRequest {
	path: string;
	status: number;
	tools: string[];
	toolsHash: string;
	systemHash: string;
	/** Items in `messages` / `input` / `contents`. */
	items: number;
	bodyBytes: number;
	/** Tool-change carriers found in the body: `tool_addition`, `tool_removal`, `additional_tools`. */
	toolChangeCarriers: string[];
	/** `cache_control` markers by TTL (`5m` when unset), and OpenAI breakpoint / cache-key fields. */
	cacheMarkers: Record<string, number>;
	anthropicBeta?: string;
	usage: NormalizedUsage;
	rawUsage: Record<string, unknown>;
}

export interface NormalizedUsage {
	/** Every prompt token, cached or not. */
	promptTotal: number;
	/** Prompt tokens billed at the full input rate. */
	uncached: number;
	cacheRead: number;
	cacheWrite: number;
	write5m?: number;
	write1h?: number;
	output: number;
}

const sha = (v: unknown): string =>
	v === undefined ? "-" : createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 10);

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

function toolNames(body: Record<string, unknown>): string[] {
	const tools = Array.isArray(body.tools) ? (body.tools as Record<string, unknown>[]) : [];
	const out: string[] = [];
	for (const t of tools) {
		if (Array.isArray(t.functionDeclarations))
			for (const f of t.functionDeclarations as { name?: string }[]) out.push(String(f.name));
		else out.push(String(t.name ?? (t.function as { name?: string } | undefined)?.name ?? t.type));
	}
	return out;
}

function cacheMarkers(body: Record<string, unknown>): Record<string, number> {
	const out: Record<string, number> = {};
	const bump = (k: string): void => void (out[k] = (out[k] ?? 0) + 1);
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (!v || typeof v !== "object") return;
		const o = v as Record<string, unknown>;
		if (o.cache_control && typeof o.cache_control === "object")
			bump(`cache_control:${(o.cache_control as { ttl?: string }).ttl ?? "5m"}`);
		if (o.prompt_cache_breakpoint !== undefined)
			bump(`prompt_cache_breakpoint:${JSON.stringify(o.prompt_cache_breakpoint)}`);
		for (const x of Object.values(o)) walk(x);
	};
	walk(body);
	for (const k of ["prompt_cache_key", "prompt_cache_retention"]) if (body[k] !== undefined) bump(k);
	if (body.prompt_cache_options !== undefined)
		bump(`prompt_cache_options:${JSON.stringify(body.prompt_cache_options)}`);
	return out;
}

/** The usage objects a streamed (SSE) or JSON response carries, merged in order. */
function collectUsage(text: string): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	const take = (u: unknown): void => {
		if (!u || typeof u !== "object") return;
		for (const [k, v] of Object.entries(u as Record<string, unknown>)) if (v !== null && v !== undefined) merged[k] = v;
	};
	const lines = text.includes("data:") ? text.split("\n").filter((l) => l.startsWith("data:")) : [text];
	for (const line of lines) {
		let v: Record<string, unknown>;
		try {
			v = JSON.parse(line.replace(/^data:\s*/, "")) as Record<string, unknown>;
		} catch {
			continue;
		}
		for (const one of Array.isArray(v) ? v : [v]) {
			const o = one as Record<string, unknown>;
			take(o.usage);
			take(o.usageMetadata);
			take((o.message as Record<string, unknown> | undefined)?.usage);
			take((o.response as Record<string, unknown> | undefined)?.usage);
		}
	}
	return merged;
}

export function normalizeUsage(api: string, u: Record<string, unknown>): NormalizedUsage {
	if (api === "anthropic-messages") {
		const creation = (u.cache_creation ?? {}) as Record<string, unknown>;
		const uncached = num(u.input_tokens);
		const cacheRead = num(u.cache_read_input_tokens);
		const cacheWrite = num(u.cache_creation_input_tokens);
		return {
			promptTotal: uncached + cacheRead + cacheWrite,
			uncached,
			cacheRead,
			cacheWrite,
			write5m: num(creation.ephemeral_5m_input_tokens),
			write1h: num(creation.ephemeral_1h_input_tokens),
			output: num(u.output_tokens),
		};
	}
	if (api === "google-generative-ai") {
		const total = num(u.promptTokenCount);
		const cacheRead = num(u.cachedContentTokenCount);
		return {
			promptTotal: total,
			uncached: total - cacheRead,
			cacheRead,
			cacheWrite: 0,
			output: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount),
		};
	}
	// OpenAI Responses and Chat Completions: input totals include the cached part.
	const details = (u.input_tokens_details ?? u.prompt_tokens_details ?? {}) as Record<string, unknown>;
	const total = num(u.input_tokens ?? u.prompt_tokens);
	const cacheRead = num(details.cached_tokens);
	const cacheWrite = num(
		details.cache_write_tokens ?? details.cache_creation_tokens ?? details.cache_creation_input_tokens,
	);
	return {
		promptTotal: total,
		uncached: total - cacheRead - cacheWrite,
		cacheRead,
		cacheWrite,
		output: num(u.output_tokens ?? u.completion_tokens),
	};
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

const HOP = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding", "keep-alive"]);

/**
 * A loopback pass-through proxy: the agent's provider base URL points here, every request goes byte for byte to
 * `upstreamBase` + path, and the proxy records the request body facts and the response usage. Headers are forwarded
 * but never recorded (they hold the key), except `anthropic-beta`.
 */
export async function startRecordingProxy(
	api: string,
	upstreamBase: string,
): Promise<{ url: string; requests: ProbeRequest[]; close(): Promise<void> }> {
	const requests: ProbeRequest[] = [];
	const base = upstreamBase.replace(/\/$/, "");
	const server: Server = createServer(async (req, res) => {
		try {
			const raw = await readBody(req);
			const headers: Record<string, string> = {};
			for (const [k, v] of Object.entries(req.headers))
				if (!HOP.has(k) && v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
			const upstream = await fetch(`${base}${req.url ?? ""}`, {
				method: req.method,
				headers,
				body: req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(raw),
			});
			const out: Record<string, string> = {};
			upstream.headers.forEach((v, k) => {
				if (!HOP.has(k) && k !== "content-encoding") out[k] = v;
			});
			res.writeHead(upstream.status, out);
			let text = "";
			if (upstream.body) {
				const decoder = new TextDecoder();
				for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) {
					res.write(chunk);
					if (text.length < 4_000_000) text += decoder.decode(chunk, { stream: true });
				}
			}
			res.end();
			let body: Record<string, unknown> = {};
			try {
				body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
			} catch {
				// not a JSON request (a GET): recorded with empty facts
			}
			const json = JSON.stringify(body);
			const rawUsage = collectUsage(text);
			const items = (body.messages ?? body.input ?? body.contents) as unknown[] | undefined;
			requests.push({
				path: (req.url ?? "").replace(/key=[^&]+/, "key=…"),
				status: upstream.status,
				tools: toolNames(body),
				toolsHash: sha(body.tools),
				systemHash: sha(body.system ?? body.instructions ?? body.systemInstruction),
				items: Array.isArray(items) ? items.length : 0,
				bodyBytes: raw.length,
				toolChangeCarriers: ["tool_addition", "tool_removal", "additional_tools"].filter((k) => json.includes(k)),
				cacheMarkers: cacheMarkers(body),
				anthropicBeta: headers["anthropic-beta"],
				usage: normalizeUsage(api, rawUsage),
				rawUsage,
			});
		} catch (e) {
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
			res.end(`probe proxy: ${(e as Error).message}`);
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

export interface AgentRun {
	exitCode: number | null;
	timedOut: boolean;
	stderr: string;
	events: Record<string, unknown>[];
}

/**
 * Runs the bundle once in an isolated HOME with several prompts, one session: `--mode json` takes the first prompt
 * and each later positional message as a further turn.
 */
export async function runAgent(opts: {
	bundle: string;
	provider: ProbeProvider;
	baseUrl: string;
	prompts: string[];
	mcpServers?: Record<string, string>;
	thinking?: string;
	timeoutMs?: number;
	/** Extra environment for the agent process, e.g. `OCTOCODE_CACHE_RETENTION`. Never a key. */
	env?: Record<string, string>;
}): Promise<AgentRun> {
	const p = opts.provider;
	const session = await octocodecodeAdapter({
		bundle: opts.bundle,
		provider: { id: p.id, api: p.api, model: p.model, baseUrl: opts.baseUrl, key: p.key },
		thinking: opts.thinking,
		persistSession: true,
	}).start({ gatewayUrl: opts.baseUrl, mcpUrls: opts.mcpServers, env: opts.env });
	try {
		const r = await session.run({ prompts: opts.prompts, timeoutMs: opts.timeoutMs ?? 240_000 });
		return { exitCode: r.exitCode, timedOut: r.timedOut, stderr: r.stderr, events: r.events };
	} finally {
		await session.close();
	}
}

/** Usage Octocode recorded on each assistant `message_end`, in order. */
export function recordedUsage(events: Record<string, unknown>[]): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const e of events) {
		if (e.type !== "message_end") continue;
		const m = e.message as { role?: string; usage?: Record<string, unknown> } | undefined;
		if (m?.role === "assistant" && m.usage) out.push(m.usage);
	}
	return out;
}
