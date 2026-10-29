import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkFidelity, type CompactServerInput, renderServer } from "../src/compact/index.ts";
import { octocodeCompactOverrides } from "../src/presets/octocode/compact-overrides.ts";
import { octocodePreset } from "../src/presets/octocode/index.ts";

const catalog = JSON.parse(
	readFileSync(new URL("./fixtures/compact/octocode-catalog.json", import.meta.url), "utf8"),
) as CompactServerInput;

describe("Octocode preset compact overrides", () => {
	const overrides = octocodeCompactOverrides(catalog);

	it("are written for the fixture catalog: rewrite a tool's entries when its hash changes", () => {
		expect(overrides).toBeDefined();
	});

	it("pass the fidelity check and shrink the prose of the rendered file", () => {
		const text = renderServer(catalog, overrides);
		expect(checkFidelity(catalog, text, overrides)).toEqual({ ok: true, problems: [] });
		expect(text.length).toBeLessThan(renderServer(catalog).length);
		expect(text).not.toContain("<when>");
	});

	it("cover every tool of the catalog", () => {
		expect(Object.keys(overrides?.tools ?? {}).sort()).toEqual(catalog.tools.map((tool) => tool.name).sort());
	});

	it("give every tool a one-line trigger", () => {
		expect(Object.keys(overrides?.triggers ?? {}).sort()).toEqual(catalog.tools.map((tool) => tool.name).sort());
		for (const trigger of Object.values(overrides?.triggers ?? {})) {
			expect(trigger).not.toMatch(/[\r\n]/);
			expect(trigger.length).toBeLessThanOrEqual(200);
		}
	});

	it("drop only the entries of a tool that changed", () => {
		const [first, ...rest] = catalog.tools;
		const changed = { ...catalog, tools: [{ ...first, description: `${first.description} Changed.` }, ...rest] };
		const kept = octocodeCompactOverrides(changed);
		expect(kept?.tools?.[first.name]).toBeUndefined();
		for (const tool of rest) expect(kept?.tools?.[tool.name]).toBe(overrides?.tools?.[tool.name]);
		expect(octocodeCompactOverrides({ ...catalog, tools: [] })?.tools).toBeUndefined();
	});

	it("are offered through the preset hook", () => {
		expect(octocodePreset().compactOverrides?.(catalog)).toEqual(overrides);
	});
});
