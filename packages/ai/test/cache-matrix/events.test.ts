/**
 * Event x API cache matrix on the wire. Each event is a transcript step run through every adapter's real request builder
 * (payload and headers captured, nothing sent). Unless the event is a documented rewrite, the request after it must open
 * with the request before it: the same tools, the same instruction blocks, and the earlier conversation byte for byte
 * (cache markers move to the new tail by design, so they are compared apart). Markers and routing identifiers must stay
 * where the API expects them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Model } from "../../src/types.ts";
import { getToolLoadingMode } from "../../src/utils/tool-loading.ts";
import { assistant, CALL, LOOKUP_FULL, toolResult, transcript, update, user, type Step } from "./transcripts.ts";
import { expectAppend, markerCount, changed, items } from "./compare.ts";
import { bytes, WIRE_CASES, wireRequest, type Wire, type WireCase, type WireId } from "./wire.ts";

beforeEach(() => {
	for (const name of ["OCTOCODE_CACHE_RETENTION", "OCTOCODE_INSTRUCTION_CACHE_RETENTION", "OCTOCODE_PROMPT_CACHE_KEY"])
		vi.stubEnv(name, undefined);
});
afterEach(() => vi.unstubAllEnvs());

/** Markers and routing identifiers every request of every event must keep. */
function expectMarkers(entry: WireCase, wire: Wire) {
	if (entry.implicit) {
		// Implicit prefix caching: nothing cache-shaped goes out.
		expect(wire.body).not.toMatch(/cache/i);
		return;
	}
	if (entry.id === "anthropic" || entry.id === "completions-explicit") {
		expect(markerCount(wire)).toBeGreaterThan(0);
		expect(markerCount(wire)).toBeLessThanOrEqual(4);
	}
	if (entry.id === "completions-plain") expect(markerCount(wire)).toBe(0);
	if (entry.keyField && entry.id !== "completions-explicit") expect(wire.payload[entry.keyField]).toBe("wire-session");
	const header: Partial<Record<WireId, string>> = {
		xai: "x-grok-conv-id",
		"completions-explicit": "x-session-id",
		responses: "x-client-request-id",
	};
	if (header[entry.id]) expect(wire.headers.get(header[entry.id]!)).toBe("wire-session");
}

const send = async (entry: WireCase, messages: Message[], model: Model<any> = entry.model()) => {
	const wire = await wireRequest(entry, transcript(messages), {}, model);
	expectMarkers(entry, wire);
	return wire;
};

/** Events that append to the conversation; the step builds both requests on the case's model. */
const STEPS: Record<string, (model: Model<any>) => Step> = {
	"next turn append": (m) => ({
		before: [user("one", 1)],
		after: [user("one", 1), assistant(m, 2, "ok"), user("two", 3)],
	}),
	// Where the transport cannot redeclare a tool in place, the session leaves the tool thin: its schema arrives as a
	// tool result and the tool list is not touched.
	"deferred tool loaded (schema in the tool result, tool list untouched)": (m) => ({
		before: [user("one", 1)],
		after: [
			user("one", 1),
			assistant(m, 2, "", CALL("lookup")),
			toolResult("lookup", "call_1", "schema: query (string)", 3),
			assistant(m, 4, "found"),
			user("two", 5),
		],
	}),
	"refused call returns the schema": (m) => ({
		before: [user("one", 1)],
		after: [
			user("one", 1),
			assistant(m, 2, "", CALL("lookup")),
			toolResult("lookup", "call_1", "Invalid arguments. Schema: query (string, required)", 3, true),
			assistant(m, 4, "retry"),
			user("two", 5),
		],
	}),
	"skill loaded as a tool result": (m) => ({
		before: [user("one", 1)],
		after: [
			user("one", 1),
			assistant(m, 2, "", CALL("read")),
			toolResult("read", "call_1", "# Skill body\n".repeat(300), 3),
			assistant(m, 4, "done"),
			user("two", 5),
		],
	}),
	"images in history": (m) => ({
		before: [user("look", 1, true)],
		after: [user("look", 1, true), assistant(m, 2, "seen"), user("and now", 3)],
	}),
};

describe.each(WIRE_CASES)("$label", (entry) => {
	it.each(Object.keys(STEPS))("%s: the request after opens with the request before", async (event) => {
		const { before, after } = STEPS[event](entry.model());
		const first = await send(entry, before);
		const second = await send(entry, after);
		// Not vacuous: the second request carries more conversation than the first.
		expect(items(entry, second).length).toBeGreaterThan(items(entry, first).length);
		expectAppend(entry, first, second);
		// A rewrite happens once: the request after the event's request opens with it unchanged.
		const third = await send(entry, [...after, assistant(entry.model(), 90, "next"), user("three", 91)]);
		expectAppend(entry, second, third);
	});

	it("a fork sends its parent's request byte for byte", async () => {
		const m = entry.model();
		const messages = [user("one", 1), assistant(m, 2, "ok"), user("two", 3)];
		const parent = await wireRequest(entry, transcript(messages), { sessionId: "parent" });
		const fork = await wireRequest(entry, transcript(messages), { sessionId: "fork", promptCacheKey: "parent" });
		expect(fork.body).toBe(parent.body);
		// Routing identifiers match as well: the fork lands on the replica that holds the parent's prefix.
		const routing = (wire: Wire) =>
			[...wire.headers.entries()].filter(([name]) => /session|conv|request-id/.test(name));
		expect(routing(fork)).toEqual(routing(parent));
	});

	it("two children with different tasks share tools, instructions and marker placement", async () => {
		const env = { OCTOCODE_PROMPT_CACHE_KEY: "octocode-child-group" };
		const a = await wireRequest(entry, transcript([user("find the retry policy", 1)]), { sessionId: "child-a", env });
		const b = await wireRequest(entry, transcript([user("review the session manager", 1)]), {
			sessionId: "child-b",
			env,
		});
		expect(bytes(entry.tools(b.payload))).toBe(bytes(entry.tools(a.payload)));
		expect(bytes(entry.instructions(b.payload))).toBe(bytes(entry.instructions(a.payload)));
		expect(markerCount(b)).toBe(markerCount(a));
		if (entry.keyField && entry.id !== "completions-explicit")
			expect(b.payload[entry.keyField]).toBe(a.payload[entry.keyField]);
	});

	it("overflow retry: compaction rewrites the history once, keeps tools and instructions, then appends again", async () => {
		const m = entry.model();
		const long = [
			user("look", 1, true),
			assistant(m, 2, "seen"),
			user("more", 3),
			assistant(m, 4, "ok"),
			user("huge request", 5),
		];
		const overflowing = await send(entry, long);
		// The retry sends a summary in place of the first turns, with the images stripped.
		const compacted = [user("Summary of the earlier work.", 6), user("huge request", 5)];
		const retried = await send(entry, compacted);
		expect(changed(entry, overflowing, retried, ["tools", "instructions"])).toEqual([]);
		const next = await send(entry, [...compacted, assistant(m, 7, "done"), user("next", 8)]);
		expectAppend(entry, retried, next);
	});

	it.each([
		["model switch on the same provider", (e: WireCase) => [e, e.alt()] as const],
		[
			"provider switch",
			(e: WireCase) => {
				const next = WIRE_CASES[(WIRE_CASES.indexOf(e) + 1) % WIRE_CASES.length];
				return [next, next.model()] as const;
			},
		],
	])("%s: rewrites the request once, then appends on the new model", async (_name, pick) => {
		const origin = entry.model();
		const [targetCase, target] = pick(entry);
		const turns = [user("one", 1), assistant(origin, 2, "ok"), user("two", 3)];
		const switched = await send(targetCase, turns, target);
		const continued = await send(targetCase, [...turns, assistant(target, 4, "again"), user("three", 5)], target);
		expectAppend(targetCase, switched, continued);
	});
});

/** The model of `entry` whose transport redeclares a tool in place (tool_addition, additional_tools), if one is known. */
const redeclaring = (entry: WireCase) => [entry.model(), entry.alt()].find((m) => getToolLoadingMode(m) === "changes");

describe.each(WIRE_CASES.filter((entry) => redeclaring(entry)))(
	"$label: deferred tool redeclared in place",
	(entry) => {
		it("appends the full definition and keeps the tools and instructions that were sent", async () => {
			const m = redeclaring(entry)!;
			const before = [user("one", 1)];
			const after = [
				user("one", 1),
				assistant(m, 2, "", CALL("lookup")),
				toolResult("lookup", "call_1", "loaded", 3),
				update({ toolsAdded: [LOOKUP_FULL] }, 4),
				assistant(m, 5, "found"),
				user("two", 6),
			];
			const [first, second] = [await send(entry, before, m), await send(entry, after, m)];
			// `search` already declares a `query` property; the definition adds a second one.
			const declared = (wire: Wire) => wire.body.split('"properties":{"query":').length - 1;
			expect(declared(second)).toBe(declared(first) + 1);
			expectAppend(entry, first, second);
			// It happens once: the next request opens with this one.
			expectAppend(entry, second, await send(entry, [...after, assistant(m, 90, "next"), user("three", 91)], m));
		});
	},
);

describe("tool-loading modes the matrix relies on", () => {
	it("only transports that redeclare in place get the redeclared-definition event", () => {
		expect(
			WIRE_CASES.filter((entry) => redeclaring(entry)).map((entry) => `${entry.id}:${redeclaring(entry)!.id}`),
		).toEqual(["anthropic:claude-opus-5-5", "responses:gpt-6-luna"]);
	});
});
