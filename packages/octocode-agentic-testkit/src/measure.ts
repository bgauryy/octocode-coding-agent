import type { CapturedRequest } from "./trace.ts";

/** One top-level section of a system prompt: a line-start `<tag …>` up to its `</tag>`. */
export interface SectionSize {
	tag: string;
	/** The opening tag's attributes, as written (`name="x"`), when it has any. */
	attrs?: string;
	bytes: number;
}

/** One system block as sent; `cacheControl` is the block's cache marker TTL (`5m` when unset), absent without one. */
export interface SystemBlockSize {
	index: number;
	bytes: number;
	cacheControl?: string;
	sections: SectionSize[];
	/** Bytes outside any section (preamble, blank lines between sections). */
	loose: number;
}

/** A tool's size split into the prose a model reads and the JSON that carries it. */
export interface ToolSize {
	name: string;
	descriptionBytes: number;
	/** `description` strings inside the input schema. */
	schemaProseBytes: number;
	/** Schema JSON minus its description strings. */
	schemaStructureBytes: number;
}

/** A sentence said in more than one place (normalized: case, whitespace and list markers ignored). */
export interface RepeatedText {
	text: string;
	count: number;
	/** Where each copy sits: `system:<tag>`, `tool:<name>` or `schema:<name>`. */
	where: string[];
}

export interface PromptShape {
	systemBytes: number;
	blocks: SystemBlockSize[];
	tools: ToolSize[];
	toolBytes: number;
	/** Cache markers (`cache_control`) by where they sit: tool indexes, system block indexes, message indexes. */
	markers: { tools: number[]; system: number[]; messages: number[] };
	/**
	 * Bytes of the prompt prefix ending at each marker, in wire order (tools, system, messages): what a provider can
	 * reuse from cache at that breakpoint. JSON bytes for tools and messages, text bytes for system blocks.
	 */
	cachedPrefixes: { at: string; bytes: number }[];
	repeated: RepeatedText[];
}

export interface ShapeOptions {
	/** Shortest sentence counted as a repeat (characters, after normalizing). Default 40. */
	minSentenceChars?: number;
}

const bytes = (s: string): number => Buffer.byteLength(s);

interface RawTool {
	name?: string;
	description?: string;
	input_schema?: unknown;
	parameters?: unknown;
	function?: { name?: string; description?: string; parameters?: unknown };
}

/** A tool entry's name, description and input schema on the OpenAI chat, Responses or Anthropic wire. */
export function toolParts(tool: unknown): { name: string; description: string; schema: unknown } {
	const t = (tool ?? {}) as RawTool;
	return {
		name: t.name ?? t.function?.name ?? "?",
		description: t.description ?? t.function?.description ?? "",
		schema: t.input_schema ?? t.parameters ?? t.function?.parameters ?? {},
	};
}

/** Characters of `description` strings anywhere inside a JSON schema. */
export function schemaProse(node: unknown): string[] {
	if (Array.isArray(node)) return node.flatMap(schemaProse);
	if (!node || typeof node !== "object") return [];
	return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
		k === "description" && typeof v === "string" ? [v] : schemaProse(v),
	);
}

/** Line-start `<tag …>…</tag>` sections of a text, in order; text outside them counts as loose. */
export function sections(text: string): { sections: (SectionSize & { text: string })[]; loose: number } {
	const out: (SectionSize & { text: string })[] = [];
	const open = /^<([a-z_][\w-]*)((?:\s[^>]*)?)>/gm;
	let covered = 0;
	let m: RegExpExecArray | null;
	while ((m = open.exec(text))) {
		const close = `</${m[1]}>`;
		const end = text.indexOf(close, m.index + m[0].length);
		if (end === -1) continue;
		const body = text.slice(m.index, end + close.length);
		const attrs = m[2].trim();
		out.push({ tag: m[1], ...(attrs ? { attrs } : {}), bytes: bytes(body), text: body });
		covered += bytes(body);
		open.lastIndex = end + close.length;
	}
	return { sections: out, loose: bytes(text) - covered };
}

const normalize = (s: string): string =>
	s
		.replace(/^\s*(?:[-*]|\d+\.)\s+/, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();

/** Sentences that occur more than once across the given texts. */
export function repeatedSentences(texts: { where: string; text: string }[], minChars = 40): RepeatedText[] {
	const seen = new Map<string, RepeatedText>();
	for (const { where, text } of texts)
		for (const raw of text.split(/(?<=[.!?:;])\s+|\n+/)) {
			const s = normalize(raw.replace(/<\/?[a-z_][^>]*>/g, ""));
			if (s.length < minChars) continue;
			const r = seen.get(s) ?? { text: s, count: 0, where: [] };
			r.count++;
			r.where.push(where);
			seen.set(s, r);
		}
	return [...seen.values()]
		.filter((r) => r.count > 1)
		.toSorted((a, b) => b.text.length * b.count - a.text.length * a.count);
}

type WireBlock = { text?: string; cache_control?: { ttl?: string } };

/** One system block's text, with its cache marker TTL (`5m` when unset) when it has a marker. */
function systemBlock(b: WireBlock): { text: string; cacheControl?: string } {
	const block: { text: string; cacheControl?: string } = { text: b.text ?? "" };
	if (b.cache_control) block.cacheControl = b.cache_control.ttl ?? "5m";
	return block;
}

/** System blocks from an Anthropic (`system`) or OpenAI chat (`messages[role=system]`) request body. */
function systemBlocks(raw: Record<string, unknown>): { text: string; cacheControl?: string }[] {
	const sys = raw.system;
	if (typeof sys === "string") return [{ text: sys }];
	if (Array.isArray(sys)) return sys.map(systemBlock);
	const messages = (raw.messages ?? []) as { role?: string; content?: unknown }[];
	return messages
		.filter((m) => m.role === "system" || m.role === "developer")
		.flatMap((m) =>
			typeof m.content === "string" ? [{ text: m.content }] : ((m.content ?? []) as WireBlock[]).map(systemBlock),
		);
}

/** Indexes of the items that carry a cache marker (`cache_control`). */
const marked = (items: unknown): number[] =>
	Array.isArray(items) ? items.flatMap((x, i) => (JSON.stringify(x).includes('"cache_control"') ? [i] : [])) : [];

/**
 * The size and layout of one captured request's prompt: system blocks with their cache markers and sections, each
 * tool's prose and structure, and sentences said more than once across system text, tool descriptions and schemas.
 */
export function promptShape(req: CapturedRequest, opts: ShapeOptions = {}): PromptShape {
	const raw = (req.raw ?? {}) as Record<string, unknown>;
	const texts: { where: string; text: string }[] = [];
	const blocks = systemBlocks(raw).map((b, index): SystemBlockSize => {
		const s = sections(b.text);
		for (const sec of s.sections) texts.push({ where: `system:${sec.tag}`, text: sec.text });
		const sizes = s.sections.map(({ text: _text, ...size }) => size);
		// Two literals, not a spread: `cacheControl` keeps its place between `bytes` and `sections`.
		return b.cacheControl
			? { index, bytes: bytes(b.text), cacheControl: b.cacheControl, sections: sizes, loose: s.loose }
			: { index, bytes: bytes(b.text), sections: sizes, loose: s.loose };
	});
	const tools = ((raw.tools ?? []) as unknown[]).map((t) => {
		const { name, description, schema } = toolParts(t);
		const prose = schemaProse(schema);
		texts.push({ where: `tool:${name}`, text: description });
		for (const p of prose) texts.push({ where: `schema:${name}`, text: p });
		const proseBytes = prose.reduce((n, p) => n + bytes(p), 0);
		return {
			name,
			descriptionBytes: bytes(description),
			schemaProseBytes: proseBytes,
			schemaStructureBytes: bytes(JSON.stringify(schema)) - proseBytes,
		};
	});
	const toolList = Array.isArray(raw.tools) ? raw.tools : [];
	const cachedPrefixes: { at: string; bytes: number }[] = [];
	let prefix = 0;
	toolList.forEach((t, i) => {
		prefix += bytes(JSON.stringify(t));
		if (marked([t]).length) cachedPrefixes.push({ at: `tool:${tools[i]?.name ?? i}`, bytes: prefix });
	});
	for (const b of blocks) {
		prefix += b.bytes;
		if (b.cacheControl) cachedPrefixes.push({ at: `system:${b.index}`, bytes: prefix });
	}
	const messageList = Array.isArray(raw.messages) ? raw.messages : [];
	messageList.forEach((m, i) => {
		prefix += bytes(JSON.stringify(m));
		if (marked([m]).length) cachedPrefixes.push({ at: `message:${i}`, bytes: prefix });
	});
	return {
		cachedPrefixes,
		markers: {
			tools: marked(raw.tools),
			system: blocks.flatMap((b) => (b.cacheControl ? [b.index] : [])),
			messages: marked(raw.messages),
		},
		systemBytes: blocks.reduce((n, b) => n + b.bytes, 0),
		blocks,
		tools,
		toolBytes: bytes(JSON.stringify(raw.tools ?? [])),
		repeated: repeatedSentences(texts, opts.minSentenceChars),
	};
}
