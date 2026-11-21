/**
 * Real Octocode sessions through every real adapter: the transcripts and options a session sent are replayed through
 * each API's request builder, and the wire must keep the cache prefix and the routing identifiers the session intends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectAppend, markerCount } from "../../../../ai/test/cache-matrix/compare.ts";
import { PIXEL } from "../../../../ai/test/cache-matrix/transcripts.ts";
import { WIRE_CASES, type Wire, type WireCase } from "../../../../ai/test/cache-matrix/wire.ts";
import { lightSessions, replay, replayAll, replayOn } from "./session-wire.ts";

/** The header each API routes its cache by, and the body field carrying the shared key. */
const ROUTING: Partial<Record<WireCase["id"], string[]>> = {
	xai: ["x-grok-conv-id", "x-client-request-id"],
	"completions-explicit": ["x-session-id"],
	responses: ["x-client-request-id"],
};

beforeEach(() => {
	for (const name of ["OCTOCODE_CACHE_RETENTION", "OCTOCODE_INSTRUCTION_CACHE_RETENTION", "OCTOCODE_PROMPT_CACHE_KEY"])
		vi.stubEnv(name, undefined);
});
afterEach(() => vi.unstubAllEnvs());

const expectBudget = (entry: WireCase, wire: Wire) => {
	if (entry.id === "anthropic" || entry.id === "completions-explicit") expect(markerCount(wire)).toBeLessThanOrEqual(4);
	if (entry.id === "completions-plain") expect(markerCount(wire)).toBe(0);
};

describe.each(WIRE_CASES)("session through $label", (entry) => {
	it("a second prompt: its request opens with the first, tools and instruction blocks unchanged", async () => {
		const s = await lightSessions();
		const manager = s.create();
		await s.prompt(manager, "first");
		await s.prompt(manager, "second");
		expect(s.recorded).toHaveLength(2);
		const [first, second] = await replayAll(s.recorded, entry);
		expectBudget(entry, first);
		expectBudget(entry, second);
		expectAppend(entry, first, second);
	});

	it("a fork routes by the parent's key and its request opens with the parent's last request", async () => {
		const s = await lightSessions();
		const parent = s.create();
		await s.prompt(parent, "first");
		await s.prompt(s.fork(parent), "second");
		const [parentRequest, forkRequest] = await replayAll(s.recorded, entry);
		expect(s.recorded[1].options.promptCacheKey).toBe(parent.getSessionId());
		expect(s.recorded[1].options.sessionId).not.toBe(parent.getSessionId());
		expectAppend(entry, parentRequest, forkRequest);
		for (const header of ROUTING[entry.id] ?? [])
			expect(forkRequest.headers.get(header), header).toBe(parentRequest.headers.get(header));
		if (entry.keyField && entry.id !== "completions-explicit")
			expect(forkRequest.payload[entry.keyField]).toBe(parentRequest.payload[entry.keyField]);
	});

	it("a child (key from OCTOCODE_PROMPT_CACHE_KEY) routes by that key whatever its session id", async () => {
		vi.stubEnv("OCTOCODE_PROMPT_CACHE_KEY", "octocode-child-0123");
		const s = await lightSessions();
		await s.prompt(s.create(), "task");
		const wire = await replay(s.recorded[0], entry);
		for (const header of ROUTING[entry.id] ?? []) expect(wire.headers.get(header), header).toBe("octocode-child-0123");
		expectBudget(entry, wire);
	});

	it("a model switch on the same provider rewrites the request once, then appends on the new model", async () => {
		const s = await lightSessions();
		const manager = s.create();
		await s.prompt(manager, "first");
		await s.prompt(manager, "second");
		await s.prompt(manager, "third", undefined, "m2");
		await s.prompt(manager, "fourth", undefined, "m2");
		expect(s.recorded.map((request) => request.ran?.id)).toEqual(["m", "m", "m2", "m2"]);
		const models: Record<string, ReturnType<WireCase["model"]>> = { m: entry.model(), m2: entry.alt() };
		const owner = (id: string) => models[id] ?? expect.unreachable(`no wire model for ${id}`);
		const wires: Wire[] = [];
		for (const request of s.recorded)
			wires.push(await replayOn(request, entry, owner(request.ran!.id), (message) => owner(message.model)));
		const [first, second, switched, continued] = wires;
		expectAppend(entry, first, second);
		expect(switched.body).toContain("answer to second");
		expectBudget(entry, switched);
		expectAppend(entry, switched, continued);
	});

	it("an image in the history keeps the prefix of the next request", async () => {
		const s = await lightSessions();
		const manager = s.create();
		await s.prompt(manager, "look at this", [{ type: "image", data: PIXEL.data, mimeType: PIXEL.mimeType }]);
		await s.prompt(manager, "and now?");
		const [first, second] = await replayAll(s.recorded, entry);
		expect(first.body).toContain(PIXEL.data.slice(0, 20));
		expectAppend(entry, first, second);
	});
});
