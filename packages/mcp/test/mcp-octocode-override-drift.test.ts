import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";
import { octocodeCompactOverrides } from "../src/presets/octocode/compact-overrides.ts";
import { catalogOf, describeWithServer } from "./stdio-catalog.ts";

function linkedServer(): string | undefined {
	try {
		return path.join(
			path.dirname(createRequire(import.meta.url).resolve("octocode-mcp/package.json")),
			"dist",
			"index.js",
		);
	} catch {
		return undefined;
	}
}

const REGENERATE =
	"Regenerate them with the octocode-context-optimization skill for each catalog the server sends (without a key, and with OCTOCODE_CLASSIFICATION_API set to any value; read both with an empty HOME so lspSearch names only the ts/js, py and c/c++ servers): rewrite the stale tools, check, run `octocode mcp compact preset octocode --overrides <file> --catalog <catalog>` for each, and merge the entries into presets/octocode/compact-overrides.json (a tool whose hash differs between the catalogs keeps a list of entries).";

describeWithServer(
	"Octocode preset overrides against the linked octocode-mcp server",
	linkedServer(),
	"the linked octocode-mcp server built at ../octocode (octocode-mcp/dist/index.js)",
	(server) => {
		for (const [label, env] of [
			["without a classification key", { OCTOCODE_CLASSIFICATION_API: "" }],
			["with a classification key", { OCTOCODE_CLASSIFICATION_API: "drift-test-key" }],
		] as const)
			it(`describe every tool and the instructions it sends ${label}`, async () => {
				const catalog = await catalogOf("octocode", [server], env);
				const overrides = octocodeCompactOverrides(catalog);
				const names = catalog.tools.map((tool) => tool.name).sort();
				const stale = names.filter((name) => overrides?.tools?.[name] === undefined);
				expect(stale, `Preset overrides are stale for ${stale.join(", ")}. ${REGENERATE}`).toEqual([]);
				expect(overrides?.server, `The server instructions changed. ${REGENERATE}`).toBeDefined();
				expect(Object.keys(overrides?.triggers ?? {}).sort()).toEqual(names);
			}, 60_000);
	},
);
