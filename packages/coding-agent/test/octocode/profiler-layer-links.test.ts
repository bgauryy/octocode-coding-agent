import { describe, expect, it } from "vitest";
import { prepare, type Entry } from "../../src/octocode/profiler/index.ts";
import { requestLayers } from "../../src/octocode/profiler/layers.ts";

function session(trace: Record<string, unknown>[], keys: Array<string | undefined> = []): ReturnType<typeof prepare> {
	const entries: Array<Record<string, unknown>> = [
		{ type: "session", id: "s", cwd: "/x" },
		{ type: "message", message: { role: "system", content: "base" } },
		{ type: "message", message: { role: "user", content: "first question" } },
		{ type: "message", message: { role: "user", content: "second question" } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: "a",
				usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 },
				requestTrace: {
					layers: trace.map((layer, index) => ({ ...layer, ...(keys[index] ? { entryKey: keys[index] } : {}) })),
				},
			},
		},
	];
	return prepare(
		entries.map(
			(entry, index) => ({ id: `e${index}`, parentId: index ? `e${index - 1}` : null, ...entry }) as unknown as Entry,
		),
	);
}

const wire = [
	{ kind: "system", index: 0, chars: 4, hash: "s" },
	{ kind: "message", role: "user", index: 0, chars: 14, hash: "m0" },
	{ kind: "message", role: "user", index: 1, chars: 15, hash: "m1" },
];

describe("request layer links", () => {
	it("never names a source from equal counts alone", () => {
		const { drafts } = requestLayers(session(wire), 4);
		const messages = drafts.filter((draft) => draft.kind === "message");
		expect(messages.map((draft) => draft.entry)).toEqual([undefined, undefined]);
		expect(messages.map((draft) => draft.structure)).toEqual(["observed", "observed"]);
		expect(messages.map((draft) => draft.link)).toEqual(["inferred", "inferred"]);
	});

	it("does not label layers with a swapped source when the count is unchanged", () => {
		const swapped = [wire[0], { ...wire[2], role: "assistant" }, { ...wire[1], role: "toolResult" }];
		const { drafts } = requestLayers(session(swapped), 4);
		const messages = drafts.filter((draft) => draft.kind === "message");
		expect(messages.every((draft) => draft.entry === undefined)).toBe(true);
		expect(messages.map((draft) => draft.link)).toEqual(["unavailable", "unavailable"]);
	});

	it("links only through a recorded identity", () => {
		const { drafts } = requestLayers(session(wire, [undefined, undefined, "message:e3"]), 4);
		const messages = drafts.filter((draft) => draft.kind === "message");
		expect(messages.map((draft) => draft.link)).toEqual(["inferred", "linked"]);
		expect(messages[1].entry).toBe(3);
		expect(messages[0].entry).toBeUndefined();
	});

	it("marks a transcript-derived request as estimated with no link", () => {
		const base = session(wire);
		base.entries[4] = {
			...base.entries[4],
			message: { ...(base.entries[4].message as object), requestTrace: undefined },
		};
		const { drafts, estimated } = requestLayers(base, 4);
		expect(estimated).toBe(true);
		expect(drafts.every((draft) => draft.structure === "estimated" && draft.link === "unavailable")).toBe(true);
	});
});
