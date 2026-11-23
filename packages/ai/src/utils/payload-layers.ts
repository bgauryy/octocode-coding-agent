/**
 * Describes what a provider request sent, layer by layer, without keeping any text: the size and a
 * short hash of each layer's wire form, and where the adapter placed a cache breakpoint. A profiler
 * compares the hashes of consecutive requests to see which layer changed. One describer per API family;
 * an API without one yields `undefined`.
 *
 * The hash is a pure 64-bit FNV-1a pair, not a cryptographic digest: this package stays host-free (no
 * `node:crypto` in browser bundles), and the hash only has to differ when a layer's bytes differ.
 */

import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { Api } from "../types/ids.ts";
import { type MeasuredLayer, PayloadLayerMemo } from "./payload-layer-memo.ts";

export { PayloadLayerMemo };

export interface RequestLayer {
	/** `tools`: the whole tool list; `system`: one system or developer block; `message`: one conversation item. */
	kind: "tools" | "system" | "message";
	role?: string;
	/** Position inside its section of the payload (system block, message or input item). */
	index?: number;
	/** Length of the layer's JSON wire form, without cache markers. */
	chars: number;
	/** 16 hex characters over the layer's JSON without cache markers, keys in payload order. */
	hash: string;
	/** The adapter marked this layer as the end of a cacheable prefix. */
	breakpoint?: boolean;
	/**
	 * The lifetime that breakpoint asked for (`5m`, `1h`, `30m`, `12h`), the provider's default when the marker names
	 * none. Each breakpoint keeps its own: a request with long instructions and short history marks both tiers.
	 */
	ttl?: string;
	/**
	 * The session entry this layer was built from (`message:<entry id>`), stamped by the host that holds the entries
	 * and only where it can show the layer is that entry's message unchanged. Absent: identity unknown.
	 */
	entryKey?: string;
}

export interface RequestTrace {
	/** In wire order: tools, system, then conversation. */
	layers: RequestLayer[];
	/**
	 * How the request asked for caching, e.g. `ephemeral`, `ephemeral-1h`, `default-1h` (Bedrock), `key`, `key+24h`,
	 * `key+12h+breakpoint-12h` (OpenAI explicit mode) or `explicit` (explicit mode without breakpoints: no caching).
	 * A marker's TTL here is the first marker's; each breakpoint's own is on its layer (`RequestLayer.ttl`).
	 */
	cacheMode?: string;
}

type Record_ = Record<string, unknown>;

const hex8 = (h: number): string => (h >>> 0).toString(16).padStart(8, "0");

/** Both 32-bit FNV-1a halves of the hash, in one pass over the text. */
function fnvPair(text: string): string {
	let low = 0x811c9dc5;
	let high = 0x9747b28c;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		low = Math.imul(low ^ code, 16777619);
		high = Math.imul(high ^ code, 16777619);
	}
	return hex8(low) + hex8(high);
}

/**
 * Cache markers are not part of the prefix a provider matches: an adapter moves its history breakpoint to the newest
 * message on every request, so hashing the marker would report the previous tail as changed.
 */
const MARKER_KEYS = new Set(["cache_control", "prompt_cache_breakpoint"]);
const withoutMarkers = (key: string, value: unknown): unknown => (MARKER_KEYS.has(key) ? undefined : value);

/**
 * An adapter sends a message's string content as one text block when it marks the message, and as the string again
 * once the marker has moved on; the provider renders both the same, so both hash as the block.
 */
function asBlocks(value: unknown): unknown {
	if (!isRecord(value) || typeof value.content !== "string" || typeof value.role !== "string") return value;
	return { ...value, content: [{ type: "text", text: value.content }] };
}

function measureWhole(value: unknown): MeasuredLayer {
	const json = JSON.stringify(value, withoutMarkers) ?? "";
	return { chars: json.length, hash: fnvPair(json) };
}

/** Builds one layer `{ kind, ...extra, chars, hash }` from its wire form `value`: in full, or through a memo. */
type Measure = (kind: RequestLayer["kind"], value: unknown, extra: Partial<RequestLayer>) => RequestLayer;

const measureEach: Measure = (kind, value, extra) => {
	const { chars, hash } = measureWhole(value);
	return { kind, ...extra, chars, hash };
};

function layer(
	measure: Measure,
	kind: RequestLayer["kind"],
	value: unknown,
	extra: Partial<RequestLayer> = {},
): RequestLayer {
	return measure(kind, kind === "message" ? asBlocks(value) : value, extra);
}

function cacheControlOf(block: unknown): Record_ | undefined {
	const control = isRecord(block) ? block.cache_control : undefined;
	return isRecord(control) ? control : undefined;
}

/** A breakpoint layer's fields: the lifetime its marker asks for, or `fallback` (the provider default) without one. */
function marked(control: Record_ | undefined, fallback: string): Partial<RequestLayer> {
	if (!control) return {};
	return { breakpoint: true, ttl: typeof control.ttl === "string" && control.ttl ? control.ttl : fallback };
}

/** Anthropic-style `cache_control` and Bedrock `cachePoint` markers without a `ttl` live five minutes. */
const MARKER_DEFAULT_TTL = "5m";

/** The marker of a message block, or of the last part of its content. */
function messageControl(message: Record_): Record_ | undefined {
	const own = cacheControlOf(message);
	if (own) return own;
	const content = message.content;
	return Array.isArray(content) ? cacheControlOf(content[content.length - 1]) : undefined;
}

function describeAnthropic(payload: Record_, measure: Measure): RequestTrace {
	const layers: RequestLayer[] = [];
	let control: Record_ | undefined;
	const mark = (found: Record_ | undefined): Partial<RequestLayer> => {
		control ??= found;
		return marked(found, MARKER_DEFAULT_TTL);
	};
	const tools = payload.tools;
	if (Array.isArray(tools) && tools.length > 0) {
		const found = tools.map(cacheControlOf).find((candidate) => candidate !== undefined);
		layers.push(layer(measure, "tools", tools, mark(found)));
	}
	const system = payload.system;
	if (typeof system === "string") {
		layers.push(layer(measure, "system", system, { index: 0 }));
	} else if (Array.isArray(system)) {
		system.forEach((block, index) => {
			layers.push(layer(measure, "system", block, { index, ...mark(cacheControlOf(block)) }));
		});
	}
	const messages = payload.messages;
	if (Array.isArray(messages)) {
		messages.forEach((message, index) => {
			const role = isRecord(message) && typeof message.role === "string" ? message.role : undefined;
			const found = isRecord(message) ? messageControl(message) : undefined;
			layers.push(layer(measure, "message", message, { ...(role ? { role } : {}), index, ...mark(found) }));
		});
	}
	const cacheMode = markerMode(control);
	return { layers, ...(cacheMode ? { cacheMode } : {}) };
}

function markerMode(control: Record_ | undefined): string | undefined {
	const ttl = control && typeof control.ttl === "string" ? control.ttl : undefined;
	const type = control && typeof control.type === "string" ? control.type : undefined;
	return type ? (ttl && ttl !== "5m" ? `${type}-${ttl}` : type) : undefined;
}

/** The first explicit breakpoint on an item's content parts (OpenAI Responses, GPT-5.6 and later). */
function explicitBreakpoint(item: Record_): Record_ | undefined {
	const content = Array.isArray(item.content) ? item.content : [];
	for (const part of content) {
		const found = isRecord(part) ? part.prompt_cache_breakpoint : undefined;
		if (isRecord(found)) return found;
	}
	return undefined;
}

function openAiCacheMode(payload: Record_, breakpoint: Record_ | undefined, control: Record_ | undefined) {
	const key = [payload.prompt_cache_key, payload.promptCacheKey].some((value) => typeof value === "string" && value);
	const options = isRecord(payload.prompt_cache_options) ? payload.prompt_cache_options : {};
	const parts = [
		key ? "key" : undefined,
		payload.prompt_cache_retention,
		options.ttl,
		options.mode,
		// A breakpoint without its own ttl inherits the request TTL (Azure), whose default is 30m.
		breakpoint
			? `breakpoint-${[breakpoint.ttl, options.ttl].find((ttl) => typeof ttl === "string") ?? "30m"}`
			: undefined,
		markerMode(control),
	].filter((part): part is string => typeof part === "string" && part !== "");
	return parts.length > 0 ? parts.join("+") : undefined;
}

function isSystemRole(role: string | undefined): boolean {
	return role === "system" || role === "developer";
}

function describeOpenAi(payload: Record_, itemsKey: "input" | "messages", measure: Measure): RequestTrace {
	const layers: RequestLayer[] = [];
	let control: Record_ | undefined;
	let breakpoint: Record_ | undefined;
	const tools = payload.tools;
	if (Array.isArray(tools) && tools.length > 0) {
		const found = tools.map(cacheControlOf).find((candidate) => candidate !== undefined);
		control ??= found;
		layers.push(layer(measure, "tools", tools, marked(found, MARKER_DEFAULT_TTL)));
	}
	// A breakpoint without its own ttl inherits the request TTL (Azure), whose default is 30m.
	const options = isRecord(payload.prompt_cache_options) ? payload.prompt_cache_options : {};
	const requestTtl = typeof options.ttl === "string" && options.ttl ? options.ttl : "30m";
	if (typeof payload.instructions === "string" && payload.instructions !== "") {
		layers.push(layer(measure, "system", payload.instructions, { index: 0 }));
	}
	const items = payload[itemsKey];
	if (typeof items === "string") {
		layers.push(layer(measure, "message", items, { role: "user", index: 0 }));
	} else if (Array.isArray(items)) {
		items.forEach((item, index) => {
			const role = isRecord(item) && typeof item.role === "string" ? item.role : undefined;
			const marker = isRecord(item) ? messageControl(item) : undefined;
			const explicit = isRecord(item) ? explicitBreakpoint(item) : undefined;
			control ??= marker;
			breakpoint ??= explicit;
			// Tools declared in place (`additional_tools`) are tool definitions wherever they sit.
			const kind =
				isRecord(item) && item.type === "additional_tools" ? "tools" : isSystemRole(role) ? "system" : "message";
			const ttl = explicit ? marked(explicit, requestTtl) : marked(marker, MARKER_DEFAULT_TTL);
			layers.push(layer(measure, kind, item, { ...(role ? { role } : {}), index, ...ttl }));
		});
	}
	const cacheMode = openAiCacheMode(payload, breakpoint, control);
	return { layers, ...(cacheMode ? { cacheMode } : {}) };
}

const isCachePoint = (block: unknown): boolean => isRecord(block) && isRecord(block.cachePoint);
const cachePointOf = (blocks: unknown[]): Record_ | undefined => {
	const found = blocks.find(isCachePoint);
	return isRecord(found) && isRecord(found.cachePoint) ? found.cachePoint : undefined;
};

/** Bedrock Converse: a `cachePoint` block marks the end of the content before it and is not a layer of its own. */
function describeBedrock(payload: Record_, measure: Measure): RequestTrace {
	const layers: RequestLayer[] = [];
	let control: Record_ | undefined;
	const tools = isRecord(payload.toolConfig) && Array.isArray(payload.toolConfig.tools) ? payload.toolConfig.tools : [];
	if (tools.length > 0) {
		const found = cachePointOf(tools);
		control ??= found;
		layers.push(
			layer(
				measure,
				"tools",
				tools.filter((tool) => !isCachePoint(tool)),
				marked(found, MARKER_DEFAULT_TTL),
			),
		);
	}
	const system = Array.isArray(payload.system) ? payload.system : [];
	system.forEach((block, index) => {
		if (!isCachePoint(block)) layers.push(layer(measure, "system", block, { index }));
		else if (layers.at(-1)?.kind === "system") {
			control ??= block.cachePoint as Record_;
			// A copy, not an edit: the layer may be the previous request's (`PayloadLayerMemo`).
			layers[layers.length - 1] = {
				...layers[layers.length - 1],
				...marked(block.cachePoint as Record_, MARKER_DEFAULT_TTL),
			};
		}
	});
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	messages.forEach((message, index) => {
		const role = isRecord(message) && typeof message.role === "string" ? message.role : undefined;
		const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
		const found = cachePointOf(content);
		control ??= found;
		const wire = isRecord(message) ? { ...message, content: content.filter((block) => !isCachePoint(block)) } : message;
		layers.push(
			layer(measure, "message", wire, { ...(role ? { role } : {}), index, ...marked(found, MARKER_DEFAULT_TTL) }),
		);
	});
	const cacheMode = markerMode(control);
	return { layers, ...(cacheMode ? { cacheMode } : {}) };
}

function describe(api: Api, payload: Record_, measure: Measure): RequestTrace | undefined {
	switch (api) {
		case "anthropic-messages":
			return describeAnthropic(payload, measure);
		case "openai-responses":
		case "azure-openai-responses":
			return describeOpenAi(payload, "input", measure);
		case "openai-completions":
		case "mistral-conversations":
			return describeOpenAi(payload, "messages", measure);
		case "bedrock-converse-stream":
			return describeBedrock(payload, measure);
		default:
			return undefined;
	}
}

/**
 * The layers of a provider payload, in wire order, or `undefined` for an API without a describer.
 * `payload` is the object the adapter is about to send (after any `onPayload` rewrite). With `memo` (one per
 * conversation), a layer whose wire form equals the previous request's layer at its position is not serialized again,
 * and an equal layer is the previous request's object; the trace is the same as without it.
 */
export function describePayloadLayers(api: Api, payload: unknown, memo?: PayloadLayerMemo): RequestTrace | undefined {
	if (!isRecord(payload)) return undefined;
	if (!memo) return describe(api, payload, measureEach);
	memo.begin(api);
	const trace = describe(api, payload, (kind, value, extra) =>
		memo.layer(kind, value, extra, MARKER_KEYS, measureWhole, ({ chars, hash }): RequestLayer => ({
			kind,
			...extra,
			chars,
			hash,
		})),
	);
	if (trace) memo.finish(trace.layers);
	return trace;
}
