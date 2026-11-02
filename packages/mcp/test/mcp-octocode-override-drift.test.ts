import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";
import { octocodeCompactOverrides, octocodeOverrideStatus } from "../src/presets/octocode/compact-overrides.ts";
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
	"Run `yarn workspace @octocodeai/octocode-mcp run generate:compact`: it reads both catalogs the server sends with an empty HOME, shows what changed upstream for each stale override, and re-points the ones you accept (`--accept <tool.field>`, after editing the text in presets/octocode/compact-overrides.json when the meaning changed).";

const VARIANTS = [
	["without a classification key", { OCTOCODE_CLASSIFICATION_API: "" }],
	["with a classification key", { OCTOCODE_CLASSIFICATION_API: "drift-test-key" }],
] as const;

describeWithServer(
	"Octocode preset overrides against the linked octocode-mcp server",
	linkedServer(),
	"the linked octocode-mcp server built at ../octocode (octocode-mcp/dist/index.js)",
	(server) => {
		it("match the upstream text of every tool, field and the instructions they replace", async () => {
			const catalogs = await Promise.all(VARIANTS.map(([, env]) => catalogOf("octocode", [server], env)));
			const stale = octocodeOverrideStatus(catalogs).map(
				(entry) => `${entry.label} (${entry.reason === "missing" ? "gone upstream" : "upstream text changed"})`,
			);
			expect(stale, `Stale preset overrides: ${stale.join(", ")}. ${REGENERATE}`).toEqual([]);
		}, 60_000);

		for (const [label, env] of VARIANTS)
			it(`describe every tool and the instructions it sends ${label}`, async () => {
				const catalog = await catalogOf("octocode", [server], env);
				const overrides = octocodeCompactOverrides(catalog);
				const names = catalog.tools.map((tool) => tool.name).sort();
				const bare = names.filter((name) => overrides?.tools?.[name] === undefined);
				expect(bare, `No description override for ${bare.join(", ")}. ${REGENERATE}`).toEqual([]);
				expect(overrides?.server, `The server instructions changed. ${REGENERATE}`).toBeDefined();
				expect(Object.keys(overrides?.triggers ?? {}).sort()).toEqual(names);
			}, 60_000);
	},
);
