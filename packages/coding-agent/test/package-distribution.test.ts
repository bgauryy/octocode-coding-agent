import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface CodingAgentPackageJson {
	bin: { octocode: string; "octocode-api": string };
	main: string;
	exports: {
		".": { import: string; types: string };
		"./rpc-entry": { import: string };
	};
}

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;

describe("package distribution entrypoints", () => {
	test("uses the bundle for executables and modular output for libraries", () => {
		expect(packageJson.bin.octocode).toBe("dist/bundle/cli.js");
		expect(packageJson.bin["octocode-api"]).toBe("dist/bundle/octocode-api.js");
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.exports["."].import).toBe("./dist/index.js");
		expect(packageJson.exports["./rpc-entry"].import).toBe("./dist/bundle/rpc-entry.js");
	});
});
