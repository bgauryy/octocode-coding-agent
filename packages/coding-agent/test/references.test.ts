import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderReferences } from "../scripts/generate-references.ts";

describe("generated reference pages", () => {
	// models.json fields lost their reference documentation.
	it("matches the committed pages", () => {
		const rendered = renderReferences();
		expect([...rendered.keys()]).toEqual([
			"docs/models-configuration.md",
			"docs/settings.md",
			"docs/rpc.md",
			"docs/hook-events.md",
		]);
		for (const [relativePath, expected] of rendered) {
			expect(
				readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf-8"),
				`${relativePath} is stale; run yarn run generate:references`,
			).toBe(expected);
		}
	});
});
