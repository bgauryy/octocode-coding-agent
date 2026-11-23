import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { tmp } from "./octocode/helpers.ts";

const helpOnly = new URL("../src/cli/args/help-only.ts", import.meta.url).href;
const resolver = new URL("../scripts/source-resolver.ts", import.meta.url).href;

describe("`--help` fast path", () => {
	it("prints help without loading the settings manager or the configuration catalog", () => {
		const home = tmp("octocode-help-imports-");
		// Lists every module the help path loads, then prints the help as `cli.ts` does.
		const script = `import { registerHooks } from "node:module";
			const loaded = [];
			registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
			const { printHelpOnly } = await import(${JSON.stringify(helpOnly)});
			printHelpOnly();
			process.stderr.write(JSON.stringify(loaded));`;
		const result = spawnSync(process.execPath, ["--import", resolver, "--input-type=module", "-e", script], {
			cwd: home,
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, OCTOCODE_HOME: home, OCTOCODE_CODING_AGENT_DIR: home, NO_COLOR: "1" },
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Usage:");
		const loaded = JSON.parse(result.stderr.slice(result.stderr.indexOf("["))) as string[];
		const source = (part: string) => loaded.filter((url) => url.includes(part));
		expect(source("/src/core/settings-manager.ts")).toEqual([]);
		expect(source("/src/configuration/")).toEqual([]);
		// Nor the terminal UI, the keybinding table or the settings schemas: `help.js` is built from this graph.
		expect(source("/packages/tui/")).toEqual([]);
		expect(source("/src/core/keybindings.ts")).toEqual([]);
		expect(source("/typebox/")).toEqual([]);
	});

	it("still refuses a --set word that is not key=value", () => {
		expect(parseArgs(["--set", "retry.maxRetries"]).diagnostics).toContainEqual(
			expect.objectContaining({ message: expect.stringContaining('expects <key>=<value>, got "retry.maxRetries"') }),
		);
		expect(parseArgs(["--set", "retry.maxRetries=5"]).set).toEqual(["retry.maxRetries=5"]);
	});
});
