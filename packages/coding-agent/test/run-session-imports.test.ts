import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { tmp } from "./octocode/helpers.ts";

const runSession = new URL("../src/main/run-session.ts", import.meta.url).href;
const resolver = new URL("../scripts/source-resolver.ts", import.meta.url).href;

/** Every module `run-session.ts` loads before it picks a mode: what print, RPC and subagent processes evaluate. */
function modulesLoadedBy(entry: string): string[] {
	const home = tmp("octocode-run-session-imports-");
	const script = `import { registerHooks } from "node:module";
		const loaded = [];
		registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
		await import(${JSON.stringify(entry)});
		process.stderr.write(JSON.stringify(loaded));`;
	const result = spawnSync(process.execPath, ["--import", resolver, "--input-type=module", "-e", script], {
		cwd: home,
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, OCTOCODE_HOME: home, OCTOCODE_CODING_AGENT_DIR: home, NO_COLOR: "1" },
	});
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stderr.slice(result.stderr.indexOf("["))) as string[];
}

describe("the session runner's static imports", () => {
	it("leave out the terminal UI and its Mermaid renderer, which only interactive mode loads", () => {
		const loaded = modulesLoadedBy(runSession);
		expect(loaded.filter((url) => url.includes("/modes/interactive/interactive-mode.ts"))).toEqual([]);
		expect(loaded.filter((url) => url.includes("/grok-mermaid/"))).toEqual([]);
	});
});
