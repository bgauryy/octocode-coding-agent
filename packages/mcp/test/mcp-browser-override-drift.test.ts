import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { browserCompactOverrides, browserOverrideStatus } from "../src/presets/browser/compact-overrides.ts";
import { browserMcpEntry } from "../src/presets/browser/launch.ts";
import { catalogOf, describeWithServer } from "./stdio-catalog.ts";

const REGENERATE =
	"Run `yarn workspace @octocodeai/octocode-mcp run generate:compact`: it shows what changed upstream for each stale override and re-points the ones you accept (`--accept <tool.field>`, after editing the text in presets/browser/compact-overrides.json when the meaning changed). A new tool needs overrides written with the octocode-context-optimization skill (`octocode mcp compact preset browser --overrides <file> --catalog <catalog>`).";

// Listing tools starts no Chrome: the server answers `initialize` and `tools/list` from its own catalog.
describeWithServer(
	"Browser preset overrides against the installed chrome-devtools server",
	browserMcpEntry(),
	"the installed @octocodeai/octocode-chrome-devtools server",
	(entry) => {
		it("match the upstream text of every tool, field and the instructions they replace, and cover every tool", async () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-browser-drift-"));
			try {
				const catalog = await catalogOf("browser", [entry], {}, cwd);
				const stale = browserOverrideStatus([catalog]).map(
					(item) => `${item.label} (${item.reason === "missing" ? "gone upstream" : "upstream text changed"})`,
				);
				expect(stale, `Stale preset overrides: ${stale.join(", ")}. ${REGENERATE}`).toEqual([]);
				const overrides = browserCompactOverrides(catalog);
				const names = catalog.tools.map((tool) => tool.name).sort();
				const bare = names.filter((name) => overrides?.triggers?.[name] === undefined);
				expect(bare, `No trigger override for ${bare.join(", ")}. ${REGENERATE}`).toEqual([]);
				expect(overrides?.server, `The server instructions changed. ${REGENERATE}`).toBeDefined();
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		}, 60_000);
	},
);
