import { describe, expect, it } from "vitest";
import {
	acceptStale,
	type CompactServerInput,
	type CompactToolInput,
	dropStale,
	presetOverridesFor,
	presetStatus,
	toPresetOverrides,
} from "../src/compact/index.ts";

const search = (extra: Record<string, unknown> = {}, description = "Search things."): CompactToolInput => ({
	name: "search",
	description,
	inputSchema: {
		type: "object",
		properties: {
			queries: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string", description: "Where to look." },
						limit: { type: "number", description: "Rows per page." },
						...extra,
					},
					required: ["path"],
				},
			},
		},
		required: ["queries"],
	},
});

const catalog = (tool: CompactToolInput, instructions = "Search, then read."): CompactServerInput => ({
	server: "s",
	instructions,
	tools: [tool],
});

const overrides = {
	server: "Search.",
	tools: { search: "Search." },
	triggers: { search: "Use to search." },
	fields: { search: { "queries.path": "Dir.", "queries.limit": "Rows." } },
};

describe("preset overrides keyed on the upstream text", () => {
	const input = catalog(search());
	const preset = toPresetOverrides(overrides, input);

	it("write a hash of the field's description beside each field's text", () => {
		expect(preset.tools?.search?.fields?.["queries.path"]).toEqual({
			upstream: expect.stringMatching(/^[0-9a-f]{16}$/),
			text: "Dir.",
		});
		expect(presetOverridesFor(preset, input)).toEqual(overrides);
		expect(presetStatus(preset, [input])).toEqual([]);
	});

	it("keep every override through a rebuild that changes no text they replace", () => {
		// A new documented field, an added example and constraint, another field order and a new definition.
		const rebuilt = search({ mainGoal: { type: "string", description: "The task this query serves." } });
		const reordered = {
			...rebuilt,
			inputSchema: {
				$defs: { 0: { type: "string", pattern: "^x$" } },
				...(rebuilt.inputSchema as object),
			},
		};
		for (const next of [rebuilt, reordered]) {
			expect(presetOverridesFor(preset, catalog(next))).toEqual(overrides);
			expect(presetStatus(preset, [catalog(next)])).toEqual([]);
		}
	});

	it("drop only the override of a field whose upstream text changed, and name it", () => {
		const rebuilt = catalog(
			search({ limit: { type: "number", description: "Rows per page; with a query, the selected lines." } }),
		);
		expect(presetOverridesFor(preset, rebuilt)?.fields).toEqual({ search: { "queries.path": "Dir." } });
		expect(presetOverridesFor(preset, rebuilt)?.tools).toEqual({ search: "Search." });
		expect(presetStatus(preset, [rebuilt])).toEqual([
			{
				label: "search.queries.limit",
				kind: "field",
				tool: "search",
				path: "queries.limit",
				reason: "changed",
				override: "Rows.",
				current: ["Rows per page; with a query, the selected lines."],
			},
		]);
	});

	it("drop the description and trigger of a tool whose description changed, and the server text when its instructions did", () => {
		const rebuilt = catalog(search({}, "Search other things."), "Read, then search.");
		const kept = presetOverridesFor(preset, rebuilt);
		expect(kept?.tools).toBeUndefined();
		expect(kept?.triggers).toBeUndefined();
		expect(kept?.server).toBeUndefined();
		expect(kept?.fields).toEqual(overrides.fields);
		expect(presetStatus(preset, [rebuilt]).map((entry) => entry.label)).toEqual(["server", "search.description"]);
	});

	it("name an override whose field or tool the server no longer has", () => {
		const gone = catalog({
			...search(),
			inputSchema: { type: "object", properties: { queries: { type: "array", items: { type: "string" } } } },
		});
		const reasons = presetStatus(preset, [gone]).map((entry) => `${entry.label}:${entry.reason}`);
		expect(reasons).toEqual(["search.queries.path:missing", "search.queries.limit:missing"]);
		const noTools = presetStatus(preset, [{ ...input, tools: [] }]);
		expect(noTools.map((entry) => entry.label)).toEqual([
			"search.description",
			"search.queries.path",
			"search.queries.limit",
		]);
		expect(noTools.every((entry) => entry.reason === "missing")).toBe(true);
	});

	it("re-point accepted overrides at the new text and drop those with nothing left", () => {
		const rebuilt = catalog(search({ limit: { type: "number", description: "Rows per page, newest first." } }));
		const stale = presetStatus(preset, [rebuilt]);
		const accepted = acceptStale(preset, [rebuilt], stale);
		expect(presetStatus(accepted, [rebuilt])).toEqual([]);
		expect(presetOverridesFor(accepted, rebuilt)).toEqual(overrides);
		expect(acceptStale(preset, [rebuilt], [])).toEqual(preset);
		const gone = catalog({ ...search(), inputSchema: { type: "object", properties: { queries: { type: "array" } } } });
		const dropped = acceptStale(preset, [gone], presetStatus(preset, [gone]));
		expect(dropped.tools?.search?.fields).toBeUndefined();
		expect(dropped.tools?.search?.description).toBe("Search.");
	});

	// Contract: dropping stale entries removes them (the description takes its trigger along), rewrites nothing, keeps the rest.
	it("drop stale overrides without re-pointing or rewriting the valid ones", () => {
		const rebuilt = catalog(
			search({ limit: { type: "number", description: "Rows per page, newest first." } }, "Changed."),
		);
		const stale = presetStatus(preset, [rebuilt]);
		const labels = stale.map((entry) => entry.label);
		expect(labels).toEqual(["search.description", "search.queries.limit"]);
		const dropped = dropStale(preset, stale);
		expect(presetStatus(dropped, [rebuilt])).toEqual([]);
		expect(dropped.tools?.search?.description).toBeUndefined();
		expect(dropped.tools?.search?.trigger).toBeUndefined();
		expect(dropped.tools?.search?.fields?.["queries.limit"]).toBeUndefined();
		expect(dropStale(preset, [])).toEqual(preset);
		const kept = presetStatus(preset, [catalog(search())]);
		expect(dropStale(preset, kept)).toEqual(preset);
	});

	it("judge a field against every catalog a server sends", () => {
		const keyed = catalog(search({ classification: { type: "string", description: "Judge." } }));
		const both = toPresetOverrides(
			{ fields: { search: { "queries.classification": "Judge it.", "queries.path": "Dir." } } },
			keyed,
		);
		expect(presetStatus(both, [input, keyed])).toEqual([]);
		expect(presetOverridesFor(both, input)?.fields).toEqual({ search: { "queries.path": "Dir." } });
		const changed = catalog(search({ classification: { type: "string", description: "Judge others." } }));
		expect(presetStatus(both, [input, changed]).map((entry) => entry.label)).toEqual(["search.queries.classification"]);
	});
});
