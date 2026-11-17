import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, hashOf, textOf, type CapturedRequest } from "../../src/trace.ts";

/** Caller-defined payloads may use `cache_control` as an ordinary key; markers never live inside them. */
const OPAQUE_KEYS = new Set(["input_schema", "input", "parameters", "definition"]);

/** Block-level `cache_control` markers in a request body (Anthropic wire), as the agent sent them. */
export function countMarkers(value: unknown): number {
	if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countMarkers(v), 0);
	if (typeof value !== "object" || value === null) return 0;
	let n = 0;
	for (const [k, v] of Object.entries(value)) {
		if (k === "cache_control") n += typeof v === "object" && v !== null ? 1 : 0;
		else if (!OPAQUE_KEYS.has(k)) n += countMarkers(v);
	}
	return n;
}

export interface Section {
	tag: string;
	bytes: number;
	hash: string;
	text: string;
}

/** Top-level `<tag>…</tag>` blocks of a system prompt, in order; text between them is `(text)`. */
export function sections(text: string): Section[] {
	const out: Section[] = [];
	const push = (tag: string, s: string): void => {
		if (!s.trim()) return;
		out.push({ tag, bytes: Buffer.byteLength(s), hash: hashOf(s), text: s });
	};
	const open = /^<([A-Za-z_][\w-]*)(?:\s[^>]*)?>/gm;
	let i = 0;
	while (i < text.length) {
		open.lastIndex = i;
		const m = open.exec(text);
		if (!m) {
			push("(text)", text.slice(i));
			break;
		}
		push("(text)", text.slice(i, m.index));
		const close = text.indexOf(`</${m[1]}>`, m.index + m[0].length);
		const end = close < 0 ? text.length : close + m[1].length + 3;
		push(m[1], text.slice(m.index, end));
		i = end;
	}
	return out;
}

export interface Layers {
	wire: "anthropic" | "openai";
	/** One canonical string per tool definition (markers dropped). */
	tools: string[];
	toolNames: string[];
	system: string;
	/** Anthropic system blocks: bytes and whether each carries a marker. */
	systemBlocks: { bytes: number; marker: boolean }[];
	/** One canonical string per non-system message (markers dropped). */
	messages: string[];
	markers: number;
	/** In-place tool blocks inside messages (`tool_addition`, `tool_removal`). */
	inlineTools: InlineTools;
	/** Each wire message as `role[block types]`. */
	wireMessages: string[];
}

const wireOutline = (messages: { role?: string; content?: unknown }[]): string[] =>
	messages.map(
		(m) =>
			`${m.role ?? "?"}[${Array.isArray(m.content) ? m.content.map((b: { type?: string }) => b.type ?? "?").join(",") : "text"}]`,
	);

export interface InlineTools {
	added: string[];
	removed: string[];
	bytes: number;
	/** Each block as `<wire message index>:<tool_definition|tool_reference>:<name>`. */
	blocks: string[];
}

/** Every `tool_addition` / `tool_removal` block in the messages, at any depth. */
export function inlineToolsOf(messages: unknown): InlineTools {
	const out: InlineTools = { added: [], removed: [], bytes: 0, blocks: [] };
	let at = -1;
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (typeof v !== "object" || v === null) return;
		const o = v as {
			type?: unknown;
			/** `{type: "tool_definition", definition}` or `{type: "tool_reference", name}`. */
			tool?: { type?: string; name?: string; definition?: { name?: string } };
		};
		if (o.type === "tool_addition" || o.type === "tool_removal") {
			const name = o.tool?.definition?.name ?? o.tool?.name ?? "?";
			(o.type === "tool_addition" ? out.added : out.removed).push(name);
			out.bytes += Buffer.byteLength(canon(v));
			out.blocks.push(`${at}:${o.tool?.type ?? "?"}:${name}`);
			return;
		}
		for (const [k, c] of Object.entries(v)) if (!OPAQUE_KEYS.has(k)) walk(c);
	};
	if (!Array.isArray(messages)) return out;
	for (const [i, m] of messages.entries()) {
		at = i;
		walk(m);
	}
	return out;
}

const canon = (v: unknown): string => canonicalize(v, { raw: true });

export function layersOf(req: CapturedRequest): Layers {
	const body = req.raw as Record<string, unknown>;
	const rawTools = (Array.isArray(body.tools) ? body.tools : []) as Record<string, unknown>[];
	const tools = rawTools.map(canon);
	const toolNames = rawTools.map((t) => String((t.function as { name?: string } | undefined)?.name ?? t.name ?? "?"));
	const rawMessages = (Array.isArray(body.messages) ? body.messages : []) as { role?: string; content?: unknown }[];
	// The Anthropic wire carries the system prompt at the top level; chat completions carry it as message 0.
	if (body.system !== undefined) {
		const blocks = Array.isArray(body.system) ? (body.system as { text?: string; cache_control?: unknown }[]) : [];
		return {
			wire: "anthropic",
			tools,
			toolNames,
			system: textOf(body.system ?? ""),
			systemBlocks: blocks.map((b) => ({ bytes: Buffer.byteLength(b.text ?? ""), marker: b.cache_control != null })),
			messages: rawMessages.map(canon),
			markers: countMarkers({ system: body.system, tools: body.tools, messages: body.messages }),
			inlineTools: inlineToolsOf(body.messages),
			wireMessages: wireOutline(rawMessages),
		};
	}
	const head = rawMessages[0]?.role === "system" || rawMessages[0]?.role === "developer" ? 1 : 0;
	return {
		wire: "openai",
		tools,
		toolNames,
		system: head ? textOf(rawMessages[0].content) : "",
		systemBlocks: [],
		messages: rawMessages.slice(head).map(canon),
		markers: countMarkers(body),
		inlineTools: inlineToolsOf(rawMessages),
		wireMessages: wireOutline(rawMessages),
	};
}

export type ChangeKind = "same" | "append" | "edit";

export interface LayerChange {
	kind: ChangeKind;
	/** Where the first difference is: a tool name, a system section tag or a message index. */
	at?: string;
}

/** Element lists: `append` when the previous list is an exact prefix of the current one. */
function listChange(prev: string[], cur: string[], label: (i: number) => string): LayerChange {
	const n = Math.min(prev.length, cur.length);
	for (let i = 0; i < n; i++) if (prev[i] !== cur[i]) return { kind: "edit", at: label(i) };
	if (prev.length === cur.length) return { kind: "same" };
	return prev.length < cur.length ? { kind: "append", at: label(n) } : { kind: "edit", at: `removed after ${n}` };
}

function systemChange(prev: string, cur: string): LayerChange {
	if (prev === cur) return { kind: "same" };
	const a = sections(prev);
	const b = sections(cur);
	const i = a.findIndex((s, k) => b[k]?.hash !== s.hash);
	const at = i < 0 ? b[a.length]?.tag : b[i]?.tag ? b[i].tag : `removed ${a[i].tag}`;
	return { kind: cur.startsWith(prev) ? "append" : "edit", at };
}

export interface TraceRow {
	index: number;
	wire: Layers["wire"];
	lastUser: string;
	/** Each message as `role bytes: first 48 characters`, to read what a delta carried. */
	outline: string[];
	bytes: { tools: number; system: number; messages: number };
	hash: { tools: string; system: string; messages: string };
	toolCount: number;
	messageCount: number;
	systemSections: { tag: string; bytes: number; hash: string }[];
	systemBlocks: Layers["systemBlocks"];
	markers: number;
	inlineTools: InlineTools;
	wireMessages: string[];
	change: { tools: LayerChange; system: LayerChange; messages: LayerChange };
	/** The earliest layer that differs from the previous request: `tools`, `system:<tag>` or `messages[i]`. */
	firstChanged: string;
	cachedTokens?: number;
	promptTokens?: number;
}

const sumBytes = (xs: string[]): number => xs.reduce((n, x) => n + Buffer.byteLength(x), 0);

function lastUserText(req: CapturedRequest): string {
	const u = req.messages.findLast((m) => m.role === "user");
	return textOf(u?.content).slice(0, 80);
}

export function traceRows(requests: CapturedRequest[]): TraceRow[] {
	const layers = requests.map(layersOf);
	return layers.map((l, i) => {
		const p = layers[i - 1];
		const change = p
			? {
					tools: listChange(p.tools, l.tools, (k) => l.toolNames[k] ?? p.toolNames[k] ?? String(k)),
					system: systemChange(p.system, l.system),
					messages: listChange(p.messages, l.messages, (k) => `messages[${k}]`),
				}
			: {
					tools: { kind: "append" as const },
					system: { kind: "append" as const },
					messages: { kind: "append" as const },
				};
		const firstChanged = !p
			? "cold"
			: change.tools.kind !== "same"
				? `tools:${change.tools.kind}@${change.tools.at}`
				: change.system.kind !== "same"
					? `system:${change.system.kind}@${change.system.at}`
					: change.messages.kind !== "same"
						? `messages:${change.messages.kind}@${change.messages.at}`
						: "none";
		return {
			index: requests[i].index,
			wire: l.wire,
			lastUser: lastUserText(requests[i]),
			outline: requests[i].messages.map((m) => {
				const t = textOf(m.content) || JSON.stringify(m.tool_calls ?? "");
				return `${m.role} ${Buffer.byteLength(t)}: ${t.slice(0, 48).replace(/\s+/g, " ")}`;
			}),
			bytes: { tools: sumBytes(l.tools), system: Buffer.byteLength(l.system), messages: sumBytes(l.messages) },
			hash: { tools: hashOf(l.tools.join("\n")), system: hashOf(l.system), messages: hashOf(l.messages.join("\n")) },
			toolCount: l.tools.length,
			messageCount: l.messages.length,
			systemSections: sections(l.system).map(({ tag, bytes, hash }) => ({ tag, bytes, hash })),
			systemBlocks: l.systemBlocks,
			markers: l.markers,
			inlineTools: l.inlineTools,
			wireMessages: l.wireMessages,
			change,
			firstChanged,
			cachedTokens: requests[i].usage?.cachedTokens,
			promptTokens: requests[i].usage?.promptTokens,
		};
	});
}

/** Writes (overwrites) the trace at `<reportDir>/cache-trace/scripted-<name>.json` and returns the path. */
export function writeTrace(reportDir: string, name: string, report: unknown): string {
	const dir = join(reportDir, "cache-trace");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `scripted-${name}.json`);
	writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
	return file;
}

/**
 * An HTTP proxy for a mock MCP server that refuses (503) until `open(target)`: the agent's startup connect fails, and a
 * later reconnect reaches the server, so the server joins mid-session.
 */
export async function gatedProxy(): Promise<{ url: string; open(target: string): void; close(): Promise<void> }> {
	let target: string | undefined;
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			if (!target) return void res.writeHead(503, { "content-type": "text/plain" }).end("testkit: not yet up");
			const headers: Record<string, string> = {};
			for (const [k, v] of Object.entries(req.headers))
				if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
			const body = chunks.length ? Buffer.concat(chunks) : undefined;
			fetch(target, { method: req.method, headers, body })
				.then(async (r) => {
					const out = Buffer.from(await r.arrayBuffer());
					const h: Record<string, string> = {};
					r.headers.forEach((v, k) => {
						if (k !== "content-length" && k !== "transfer-encoding" && k !== "content-encoding") h[k] = v;
					});
					res.writeHead(r.status, h).end(out);
				})
				.catch((e: unknown) => void res.writeHead(502).end(String(e)));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
	return {
		url,
		open: (t) => (target = t),
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/**
 * An agent home whose models.json speaks the Anthropic Messages wire to the gateway (so the gateway sees the agent's own
 * cache markers) with a small context window, and whose mcp.json lists the given servers.
 */
export function anthropicHome(opts: {
	gatewayUrl: string;
	contextWindow: number;
	mcp?: Record<string, string>;
	/** The model entry's `compat` (e.g. the flags that select the mid-conversation tool transport). */
	compat?: Record<string, unknown>;
	/** Extra fields of the model entry (`cost`, `promptCache`) and the agent's settings.json. */
	model?: Record<string, unknown>;
	settings?: Record<string, unknown>;
}): {
	home: string;
	close(): void;
} {
	const root = mkdtempSync(join(tmpdir(), "testkit-cache-trace-"));
	const home = join(root, "agent");
	mkdirSync(home, { recursive: true });
	writeFileSync(
		join(home, "models.json"),
		JSON.stringify({
			providers: {
				testkit: {
					baseUrl: opts.gatewayUrl,
					api: "anthropic-messages",
					apiKey: "no-key",
					models: [
						{
							id: "scripted",
							contextWindow: opts.contextWindow,
							maxTokens: 4096,
							...(opts.compat ? { compat: opts.compat } : {}),
							...opts.model,
						},
					],
				},
			},
		}),
	);
	if (opts.settings) writeFileSync(join(home, "settings.json"), JSON.stringify(opts.settings));
	const servers = Object.entries(opts.mcp ?? {});
	if (servers.length) {
		const mcpServers: Record<string, unknown> = {};
		for (const [name, url] of servers)
			mcpServers[name] = { url, headers: { "x-testkit-agent": "main", "x-testkit-span": "main" } };
		writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers }));
	}
	return { home, close: () => rmSync(root, { recursive: true, force: true }) };
}
