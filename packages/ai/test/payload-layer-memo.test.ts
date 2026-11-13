import { describe, expect, it } from "vitest";
import type { Api } from "../src/types/ids.ts";
import { describePayloadLayers, PayloadLayerMemo, type RequestTrace } from "../src/utils/payload-layers.ts";

/**
 * `describePayloadLayers` with a memo must give exactly the trace it gives without one, whatever happens between two
 * requests: appends, a moved breakpoint, in-place edits of earlier data (also on the very objects described before),
 * values JSON writes the same (`undefined`, functions) or cannot be vouched for (`toJSON`, class instances), dropped and
 * inserted messages, and a switch of API. Random sequences check it against the full computation.
 */

function prng(seed: number) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const int = (n: number) => Math.floor(next() * n);
	const pick = <T>(items: readonly T[]): T => items[int(items.length)];
	return { next, int, pick };
}

type Rng = ReturnType<typeof prng>;
type Json = Record<string, unknown>;

class Point {
	x = 1;
}

const WORDS = ["alpha", "beta", "gamma", "delta", "1", "2", "", "é", "\u{1F600}"];

function block(rng: Rng): Json {
	switch (rng.int(5)) {
		case 0:
			return { type: "text", text: rng.pick(WORDS) + rng.int(3) };
		case 1:
			return {
				type: "tool_use",
				id: `t${rng.int(9)}`,
				name: "bash",
				input: { command: rng.pick(WORDS), nested: [1, rng.pick(WORDS), { deep: rng.int(3) }] },
			};
		case 2:
			return { type: "tool_result", tool_use_id: `t${rng.int(9)}`, content: [{ type: "text", text: rng.pick(WORDS) }] };
		case 3:
			return { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD".repeat(rng.int(4)) } };
		default:
			return { type: "text", text: rng.pick(WORDS), extra: rng.int(2) ? null : [true, false, 0] };
	}
}

function message(rng: Rng): Json {
	const role = rng.pick(["user", "assistant"]);
	if (rng.int(4) === 0) return { role, content: rng.pick(WORDS) };
	return { role, content: Array.from({ length: 1 + rng.int(3) }, () => block(rng)) };
}

/** One edit of an earlier message, in place: some change its JSON, some only look like a change. */
function edit(rng: Rng, target: Json): void {
	const content = target.content;
	const part = Array.isArray(content) && content.length > 0 ? (content[rng.int(content.length)] as Json) : undefined;
	switch (rng.int(11)) {
		case 0:
			if (part) part.text = `${String(part.text ?? "")}x`;
			else target.content = `${String(content)}x`;
			return;
		case 1:
			// Same text as a new string instance.
			if (part && typeof part.text === "string") part.text = [...part.text].join("");
			return;
		case 2:
			// A number becomes the string JSON would not confuse with it.
			if (part) part.extra = rng.int(2) ? 1 : "1";
			return;
		case 3:
			// Reordered keys: different JSON.
			if (part) {
				const copy = { ...part };
				for (const key of Object.keys(part)) delete part[key];
				for (const key of Object.keys(copy).reverse()) part[key] = copy[key];
			}
			return;
		case 4:
			// Written the same by JSON.
			if (part) part[rng.pick(["skipped", "fn"])] = rng.int(2) ? undefined : () => 1;
			return;
		case 5:
			if (part) part.when = new Date(rng.int(3) * 1000);
			return;
		case 6:
			if (part) part.point = new Point();
			return;
		case 7:
			if (part) {
				const word = rng.pick(WORDS);
				part.custom = { toJSON: () => word };
			}
			return;
		case 8:
			// A string content becomes the single text block a breakpoint makes of it, and back: both hash alike.
			if (typeof content === "string") target.content = [{ type: "text", text: content }];
			else if (Array.isArray(content) && content.length === 1 && (content[0] as Json).type === "text")
				target.content = (content[0] as Json).text;
			return;
		case 9:
			if (part) part.list = [undefined, () => 2, Symbol("s"), null];
			return;
		default: {
			const bare = Object.create(null) as Json;
			bare.k = rng.pick(WORDS);
			if (part) part.bare = bare;
		}
	}
}

/** A copy as an adapter rebuilds it each request: new objects, the same strings, functions and class instances. */
function rebuild(value: unknown): unknown {
	if (typeof value !== "object" || value === null) return value;
	if (Array.isArray(value)) return value.map(rebuild);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	const copy = prototype === null ? Object.create(null) : {};
	for (const key of Object.keys(value)) copy[key] = rebuild((value as Json)[key]);
	return copy;
}

const MARKERS = ["cache_control", "prompt_cache_breakpoint"];

function unmark(messages: Json[]): void {
	for (const each of messages) {
		for (const key of MARKERS) delete each[key];
		if (Array.isArray(each.content)) {
			each.content = (each.content as Json[]).filter((part) => !part.cachePoint);
			for (const part of each.content as Json[]) for (const key of MARKERS) delete part[key];
		}
	}
}

/** The marker each API family puts on the newest message. */
function mark(api: Api, messages: Json[], rng: Rng): void {
	const last = messages.at(-1);
	if (!last) return;
	if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
	const parts = last.content as Json[];
	if (api === "bedrock-converse-stream") parts.push({ cachePoint: { type: "default" } });
	else if (api === "openai-responses") parts[parts.length - 1].prompt_cache_breakpoint = { ttl: "30m" };
	else parts[parts.length - 1].cache_control = rng.int(2) ? { type: "ephemeral" } : { type: "ephemeral", ttl: "1h" };
}

function payloadOf(api: Api, messages: Json[], system: string, tools: Json[]): Json {
	switch (api) {
		case "openai-completions":
			return { model: "m", tools, messages: [{ role: "system", content: system }, ...messages] };
		case "openai-responses":
			return { model: "m", tools, instructions: system, input: messages, prompt_cache_key: "k" };
		case "bedrock-converse-stream":
			return {
				toolConfig: { tools: [...tools, { cachePoint: { type: "default" } }] },
				system: [{ text: system }, { cachePoint: { type: "default" } }, { text: `${system}2` }],
				messages,
			};
		default:
			return {
				model: "m",
				tools,
				system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
				messages,
			};
	}
}

const APIS: Api[] = ["anthropic-messages", "openai-completions", "openai-responses", "bedrock-converse-stream"];

type Describe = (api: Api, payload: unknown) => RequestTrace | undefined;

/** Runs `steps` random requests and returns the steps whose trace differs from the full computation. */
function differential(seed: number, steps: number, describeWith: Describe): number[] {
	const rng = prng(seed);
	let api = rng.pick(APIS);
	let messages: Json[] = [message(rng), message(rng)];
	let system = "base";
	let tools: Json[] = [{ name: "bash", input_schema: { type: "object" } }];
	let reuseObjects = false;
	const failures: number[] = [];
	for (let step = 0; step < steps; step++) {
		const action = rng.int(10);
		if (action <= 3) for (let i = 1 + rng.int(3); i > 0; i--) messages.push(message(rng));
		else if (action === 4 && messages.length > 1) edit(rng, messages[rng.int(messages.length - 1)]);
		else if (action === 5) messages.shift();
		else if (action === 6) messages.unshift(message(rng));
		else if (action === 7) system = rng.int(2) ? "base" : `base ${step}`;
		else if (action === 8) tools = rng.int(2) ? tools : [...tools, { name: `t${step}`, input_schema: {} }];
		else if (rng.int(8) === 0) api = rng.pick(APIS);
		unmark(messages);
		mark(api, messages, rng);
		// Half the time the payload is the objects described before, edited in place since.
		reuseObjects = rng.int(2) === 0 ? !reuseObjects : reuseObjects;
		const wire = reuseObjects ? messages : (rebuild(messages) as Json[]);
		const payload = payloadOf(api, wire, system, tools);
		const expected = JSON.stringify(describePayloadLayers(api, payload));
		const actual = JSON.stringify(describeWith(api, payload));
		if (actual !== expected) failures.push(step);
		if (!reuseObjects) messages = rebuild(messages) as Json[];
	}
	return failures;
}

describe("describePayloadLayers with a memo", () => {
	it("gives the full computation's trace on random request sequences", () => {
		let layers = 0;
		let reused = 0;
		for (let seed = 1; seed <= 12; seed++) {
			const memo = new PayloadLayerMemo();
			let previous: RequestTrace | undefined;
			const withMemo: Describe = (api, payload) => {
				const trace = describePayloadLayers(api, payload, memo);
				layers += trace?.layers.length ?? 0;
				reused += trace?.layers.filter((layer) => previous?.layers.includes(layer)).length ?? 0;
				previous = trace;
				return trace;
			};
			expect(differential(seed, 300, withMemo), `seed ${seed}`).toEqual([]);
		}
		// The sequences exercise the memo: most layers are the previous request's.
		expect(reused / layers).toBeGreaterThan(0.5);
	});

	it("catches a broken cache: one keyed by position and role", () => {
		let previous: RequestTrace | undefined;
		const broken: Describe = (api, payload) => {
			const trace = describePayloadLayers(api, payload);
			if (!trace) return trace;
			const layers = trace.layers.map((layer, i) => {
				const before = previous?.layers[i];
				return before && before.kind === layer.kind && before.role === layer.role
					? { ...layer, chars: before.chars, hash: before.hash }
					: layer;
			});
			previous = { ...trace, layers };
			return previous;
		};
		expect(differential(3, 300, broken).length).toBeGreaterThan(0);
	});

	it("reuses the previous request's layer objects for an unchanged prefix", () => {
		const memo = new PayloadLayerMemo();
		const rng = prng(7);
		const messages = Array.from({ length: 20 }, () => message(rng));
		const first = describePayloadLayers(
			"anthropic-messages",
			payloadOf("anthropic-messages", messages, "s", []),
			memo,
		)!;
		messages.push(message(rng), message(rng));
		const wire = rebuild(messages) as Json[];
		mark("anthropic-messages", wire, rng);
		const second = describePayloadLayers("anthropic-messages", payloadOf("anthropic-messages", wire, "s", []), memo)!;
		expect(JSON.stringify(second)).toBe(
			JSON.stringify(describePayloadLayers("anthropic-messages", payloadOf("anthropic-messages", wire, "s", []))),
		);
		// The system block and the 20 earlier messages are the first request's own objects; the new ones are not.
		for (let i = 0; i < 21; i++) expect(second.layers[i], `layer ${i}`).toBe(first.layers[i]);
		expect(second.layers[21]).not.toBe(first.layers[21]);
	});

	it("sees an in-place edit of an object it described before", () => {
		const memo = new PayloadLayerMemo();
		const payload = payloadOf(
			"anthropic-messages",
			[{ role: "user", content: [{ type: "text", text: "a" }] }],
			"s",
			[],
		);
		const before = describePayloadLayers("anthropic-messages", payload, memo)!;
		((payload.messages as Json[])[0].content as Json[])[0].text = "b";
		const after = describePayloadLayers("anthropic-messages", payload, memo)!;
		expect(after.layers[1].hash).not.toBe(before.layers[1].hash);
		expect(after).toEqual(describePayloadLayers("anthropic-messages", payload));
	});

	it("throws as the full computation does on a payload JSON rejects", () => {
		const memo = new PayloadLayerMemo();
		const cyclic: Json = { role: "user", content: "x" };
		cyclic.self = cyclic;
		const payload = payloadOf("anthropic-messages", [cyclic], "s", []);
		expect(() => describePayloadLayers("anthropic-messages", payload)).toThrow(TypeError);
		expect(() => describePayloadLayers("anthropic-messages", payload, memo)).toThrow(TypeError);
		const fine = payloadOf("anthropic-messages", [{ role: "user", content: "x" }], "s", []);
		expect(describePayloadLayers("anthropic-messages", fine, memo)).toEqual(
			describePayloadLayers("anthropic-messages", fine),
		);
	});
});
