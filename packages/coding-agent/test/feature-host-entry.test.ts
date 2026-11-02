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
 * The command line against the feature host, as a real `octocode` process. User code extensions are gone: `-e <code>`
 * is refused, while older parents that spawn children with `--no-extensions -e builtin:mcp` keep working.
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
	it.each([["-e"], ["--extension"]])(
		"%s with a code path exits 2 and names PLUGINS.md, before loading anything",
		async (flag) => {
			sandbox = createSandbox();
			const code = join(sandbox.directory, "x.ts");
			const ran = join(sandbox.directory, "ran.txt");
			writeFileSync(
				code,
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(ran)}, "loaded"); export default () => {};`,
			);
			const result = await runCli(sandbox, [flag, code, ...PRINT]);
			expect(result.code).toBe(2);
			expect(result.stderr).toMatch(
				/--extension was removed: Octocode no longer loads user code extensions\..*PLUGINS\.md/,
			);
			expect(result.stdout).toBe("");
			expect(existsSync(ran)).toBe(false);
		},
	);

	it("refuses a code path even when it is listed beside builtin:mcp", async () => {
		sandbox = createSandbox();
		const result = await runCli(sandbox, ["--no-extensions", "-e", "builtin:mcp", "-e", "x.ts", ...PRINT]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("PLUGINS.md");
	});

	it("starts and answers with --no-extensions -e builtin:mcp, as an older parent spawns its children", async () => {
		await scripted("scripted hello");
		const result = await runCli(sandbox, ["--no-extensions", "-e", "builtin:mcp", ...PRINT]);
		expect(result.stderr).not.toContain("removed");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("scripted hello");
	}, 90_000);

	it("accepts the short -ne flag and ignores it", async () => {
		await scripted("short flag ok");
		const result = await runCli(sandbox, ["-ne", ...PRINT]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("short flag ok");
	}, 90_000);
});

describe("the settings extensions list", () => {
	it("reports each code entry as ignored, loads none of it and still answers", async () => {
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
		expect(result.stderr).toContain(`${code}: Ignored extension. User code extensions are not supported`);
		expect(result.stdout).toContain("still answering");
		expect(existsSync(ran)).toBe(false);
	}, 90_000);

	it("keeps a builtin:<id> entry as a switch, with no diagnostic", async () => {
		await scripted("mcp off");
		writeSettings(sandbox, { extensions: ["-builtin:mcp"] });
		const result = await runCli(sandbox, PRINT);
		expect(result.code).toBe(0);
		expect(result.stderr).not.toContain("Ignored extension");
		expect(result.stdout).toContain("mcp off");
	}, 90_000);
});
