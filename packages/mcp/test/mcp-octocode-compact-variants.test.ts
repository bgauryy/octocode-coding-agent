import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkFidelity, type CompactServerInput, renderServer, resolveServerFile } from "../src/compact/index.ts";
import { octocodeCompactOverrides } from "../src/presets/octocode/compact-overrides.ts";

const read = (name: string) =>
	JSON.parse(readFileSync(new URL(`./fixtures/compact/${name}`, import.meta.url), "utf8")) as CompactServerInput;

/** The server drops `clasify` and every tool's `classification` field without a classification key. */
describe("Octocode preset overrides for the catalog without a classification key", () => {
	const keyless = read("octocode-catalog-nokey.json");
	const keyed = read("octocode-catalog.json");
	const overrides = octocodeCompactOverrides(keyless);

	it("describe every tool of the catalog and its instructions", () => {
		const names = keyless.tools.map((tool) => tool.name).sort();
		expect(keyed.tools.length).toBe(keyless.tools.length + 1);
		expect(Object.keys(overrides?.tools ?? {}).sort()).toEqual(names);
		expect(Object.keys(overrides?.triggers ?? {}).sort()).toEqual(names);
		expect(overrides?.server).toBeDefined();
	});

	it("pass the fidelity check, drop the tags and shrink the file", () => {
		const text = renderServer(keyless, overrides);
		expect(checkFidelity(keyless, text, overrides)).toEqual({ ok: true, problems: [] });
		expect(text).not.toContain("<when>");
		expect(text.length).toBeLessThan(renderServer(keyless).length - 2000);
	});

	it("match lspSearch whatever language servers the host has, and name them", () => {
		const lsp = keyless.tools.find((tool) => tool.name === "lspSearch")!;
		expect(lsp.description).toContain("Servers found here: ts/js, py, c/c++.");
		const hosted = {
			...keyless,
			tools: keyless.tools.map((tool) =>
				tool === lsp ? { ...tool, description: tool.description!.replace("ts/js, py, c/c++", "ts/js, rust") } : tool,
			),
		};
		const text = octocodeCompactOverrides(hosted)?.tools?.lspSearch;
		expect(text).toContain("Servers: ts/js, rust.");
		expect(text).not.toContain("c/c++");
		expect(octocodeCompactOverrides(keyless)?.tools?.lspSearch).toContain("Servers: ts/js, py, c/c++.");
	});

	it("give each variant of a tool its own entry", () => {
		const fetched = (catalog: CompactServerInput) => octocodeCompactOverrides(catalog)?.fields?.localFetch ?? {};
		expect(fetched(keyed)["queries.classification"]).toBeDefined();
		expect(fetched(keyless)["queries.classification"]).toBeUndefined();
	});

	it.each(["ts/js, py, c/c++, go, java", "ts/js, py, rust, c/c++, go, java, csharp"])(
		"keeps the compact catalog through runtime fidelity checks with %s installed",
		(servers) => {
			const hosted = {
				...keyless,
				tools: keyless.tools.map((tool) => ({
					...tool,
					description: tool.description?.replace(/Servers found here: ([^.<]*)\./, `Servers found here: ${servers}.`),
				})),
			};
			const dir = mkdtempSync(path.join(os.tmpdir(), "compact-host-"));
			try {
				const preset = octocodeCompactOverrides(hosted);
				const first = resolveServerFile(dir, "octocode", hosted, { preset });
				expect(first.meta.overrides).toEqual(preset);
				expect(first.text).toContain(`Servers: ${servers}.`);
				expect(first.text.length).toBeLessThan(renderServer(hosted).length - 2000);
				const cached = resolveServerFile(dir, "octocode", hosted, { preset });
				expect(cached.rendered).toBe(false);
				expect(cached.text).toBe(first.text);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
