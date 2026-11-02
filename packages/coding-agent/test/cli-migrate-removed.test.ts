import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isSubcommand, shellCompletion } from "../src/cli/completion.ts";
import { tmp } from "./octocode/helpers.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const resolver = new URL("../scripts/source-resolver.ts", import.meta.url).href;

describe("`octocode migrate` is gone", () => {
	it("is not a subcommand and is not offered by shell completion", () => {
		expect(isSubcommand(["migrate"])).toBe(false);
		for (const shell of ["bash", "zsh", "fish"] as const) expect(shellCompletion(shell)).not.toMatch(/\bmigrate\b/);
	});

	it("`octocode migrate --help` prints the general help, which does not list it", () => {
		const home = tmp("octocode-migrate-removed-");
		const result = spawnSync(process.execPath, ["--import", resolver, cli, "migrate", "--help"], {
			cwd: home,
			encoding: "utf8",
			timeout: 60_000,
			env: {
				...process.env,
				OCTOCODE_HOME: home,
				OCTOCODE_CODING_AGENT_DIR: home,
				OCTOCODE_OFFLINE: "1",
				OCTOCODE_API: "0",
				OCTOCODE_MCP: "0",
				OCTOCODE_MODELS_DEV: "0",
			},
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stdout).not.toMatch(/\bmigrate\b/);
	});
});
