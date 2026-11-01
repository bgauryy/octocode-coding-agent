import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { browserCompactOverrides } from "../src/presets/browser/compact-overrides.ts";
import { browserMcpEntry } from "../src/presets/browser/launch.ts";
import { catalogOf, describeWithServer } from "./stdio-catalog.ts";

const REGENERATE =
	"Regenerate them with the octocode-context-optimization skill against the installed @octocodeai/octocode-chrome-devtools: `generate.mjs browser`, rewrite the stale tools in the stored overrides, `check.mjs browser --overrides <file>`, then `octocode mcp compact preset browser --overrides <file> --catalog <catalog>` replaces presets/browser/compact-overrides.json.";

// Listing tools starts no Chrome: the server answers `initialize` and `tools/list` from its own catalog.
describeWithServer(
	"Browser preset overrides against the installed chrome-devtools server",
	browserMcpEntry(),
	"the installed @octocodeai/octocode-chrome-devtools server",
	(entry) => {
		it("describe every tool and the instructions it sends", async () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-browser-drift-"));
			try {
				const catalog = await catalogOf("browser", [entry], {}, cwd);
				const overrides = browserCompactOverrides(catalog);
				const names = catalog.tools.map((tool) => tool.name).sort();
				const stale = names.filter((name) => overrides?.triggers?.[name] === undefined);
				expect(stale, `Preset overrides are stale for ${stale.join(", ")}. ${REGENERATE}`).toEqual([]);
				expect(overrides?.server, `The server instructions changed. ${REGENERATE}`).toBeDefined();
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		}, 60_000);
	},
);
