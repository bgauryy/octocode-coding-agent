import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createSandbox,
	QUIET_ARGS,
	runCli,
	SCRIPTED_MODEL_ARGS,
	type ModelServer,
	type Sandbox,
	startModelServer,
	writeScriptedProvider,
	writeSettings,
} from "./helpers/feature-host-cli.ts";

/**
 * The command line against the feature host, as a real `octocode` process. User code extensions are gone, and so are
 * their flags: `-e`, `--extension` and `--no-extensions` are unknown options that stop the run before anything loads.
 */
let sandbox: Sandbox;
let server: ModelServer | undefined;

afterEach(async () => {
	await server?.close();
	sandbox?.cleanup();
	server = undefined;
});

/** A scripted model that answers once; `-p` prints the answer. */
async function scripted(answer: string) {
	sandbox = createSandbox();
	server = await startModelServer([{ text: answer }]);
	writeScriptedProvider(sandbox, server);
}

const PRINT = [...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS, "-p", "say hello"];

describe("removed extension flags", () => {
	it.each([["-e"], ["--extension"]])("%s with a code path is an unknown option and loads nothing", async (flag) => {
		sandbox = createSandbox();
		const code = join(sandbox.directory, "x.ts");
		const ran = join(sandbox.directory, "ran.txt");
		writeFileSync(
			code,
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(ran)}, "loaded"); export default () => {};`,
		);
		const result = await runCli(sandbox, [flag, code, ...PRINT]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toMatch(new RegExp(`Unknown option:? ${flag}`));
		expect(result.stdout).not.toContain("scripted");
		expect(existsSync(ran)).toBe(false);
	});

	it("refuses --no-extensions as an unknown option", async () => {
		await scripted("never printed");
		const result = await runCli(sandbox, ["--no-extensions", ...PRINT]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("--no-extensions");
		expect(result.stdout).not.toContain("never printed");
	}, 90_000);
});

describe("a leftover settings extensions key", () => {
	it("warns that the key is ignored, loads none of it and still answers", async () => {
		await scripted("still answering");
		const code = join(sandbox.directory, "ext.mjs");
		const ran = join(sandbox.directory, "ran.txt");
		writeFileSync(
			code,
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(ran)}, "loaded"); export default () => {};`,
		);
		writeSettings(sandbox, { extensions: [code] });
		const result = await runCli(sandbox, PRINT);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain('Setting "extensions" is ignored');
		expect(result.stdout).toContain("still answering");
		expect(existsSync(ran)).toBe(false);
	}, 90_000);

	it("does not let a builtin:<id> entry switch MCP off", async () => {
		await scripted("mcp off");
		writeSettings(sandbox, { extensions: ["-builtin:mcp"] });
		const result = await runCli(sandbox, PRINT);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("mcp off");
	}, 90_000);
});
