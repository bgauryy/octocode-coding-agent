import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface CodingAgentPackageJson {
	bin: { octocode: string; "octocode-api": string };
	main: string;
	exports: Record<string, { import: string; types?: string }>;
	dependencies: Record<string, string>;
	types?: string;
	octocodeRelease: { runtime: string[]; registry: Record<string, string> };
}

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;

describe("package distribution entrypoints", () => {
	test("all JavaScript is one bundle file behind small launchers, with no declarations", () => {
		expect(packageJson.bin.octocode).toBe("dist/bundle/cli.js");
		expect(packageJson.bin["octocode-api"]).toBe("dist/bundle/octocode-api.js");
		expect(packageJson.main).toBe("./dist/bundle/octocode.js");
		expect(packageJson.types).toBeUndefined();
		expect(packageJson.exports["./rpc-entry"].import).toBe("./dist/bundle/rpc-entry.js");
		for (const [subpath, entry] of Object.entries(packageJson.exports)) {
			if (subpath !== "./rpc-entry") expect(entry.import).toBe("./dist/bundle/octocode.js");
			expect(entry.types).toBeUndefined();
		}
	});

	test("the published bundle keeps testing helpers out of its root and its subpaths", () => {
		expect(Object.keys(packageJson.exports).filter((subpath) => /test/i.test(subpath))).toEqual([]);
		const bundle = readFileSync(new URL("../src/bundle.ts", import.meta.url), "utf8");
		expect(bundle).not.toMatch(/\btesting\b/);
		// The source still has them, for this repository's own tests.
		expect(existsSync(new URL("../../mcp/src/client/testing/index.ts", import.meta.url))).toBe(true);
	});

	test("every local dependency has an exact npm version for a release", () => {
		const local = Object.entries(packageJson.dependencies)
			.filter(([, specifier]) => /^(?:link|file):/.test(specifier))
			.map(([name]) => name);
		expect(Object.keys(packageJson.octocodeRelease.registry).sort()).toEqual(local.sort());
		for (const version of Object.values(packageJson.octocodeRelease.registry))
			expect(version).toMatch(/^\d+\.\d+\.\d+$/);
		for (const name of packageJson.octocodeRelease.runtime) expect(packageJson.dependencies[name]).toBeDefined();
	});

	test("ships the repository's license text", () => {
		const license = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
		expect(license("../LICENSE")).toBe(license("../../../LICENSE"));
	});
});
