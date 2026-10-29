import { describe, expect, it } from "vitest";
import { checkFidelity, type CompactServerInput, renderServer } from "../src/compact/index.ts";

const input: CompactServerInput = {
	server: "demo",
	tools: [
		{
			name: "find",
			description: "Find things.",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string", description: "Source input doc." } },
				required: ["query"],
			},
			outputSchema: {
				type: "object",
				properties: {
					results: {
						type: "array",
						items: {
							type: "object",
							properties: { path: { type: "string", description: "Source output doc." } },
						},
					},
					query: { type: "string", description: "Source output query doc." },
				},
			},
		},
	],
};

describe("field overrides under the output. prefix", () => {
	it("rewrites output field docs without touching input fields of the same name", () => {
		const overrides = {
			fields: {
				find: { query: "Input query.", "output.query": "Echoed query.", "output.results.path": "File path." },
			},
		};
		const text = renderServer(input, overrides);
		expect(text).toContain("/** Input query. */ query: string");
		expect(text).toContain("/** Echoed query. */ query?: string");
		expect(text).toContain("/** File path. */ path?: string");
		expect(text).not.toContain("Source input doc.");
		expect(text).not.toContain("Source output doc.");
		expect(text).not.toContain("Source output query doc.");
	});

	it("keeps source output docs when only input fields are overridden, and an empty text removes the doc", () => {
		const kept = renderServer(input, { fields: { find: { query: "Input query." } } });
		expect(kept).toContain("Source output doc.");
		const removed = renderServer(input, { fields: { find: { "output.results.path": "" } } });
		expect(removed).not.toContain("Source output doc.");
		expect(removed).toContain("path?: string");
	});

	it("checks output field overrides against the output schema for added URLs", () => {
		const overrides = { fields: { find: { "output.query": "See https://example.com/x." } } };
		const result = checkFidelity(input, renderServer(input, overrides), overrides);
		expect(result.problems).toEqual(["find.output.query: adds URL https://example.com/x."]);
	});
});
