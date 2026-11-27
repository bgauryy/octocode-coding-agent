import { afterEach, describe, expect, it } from "vitest";
import {
	createSandbox,
	type ModelServer,
	QUIET_ARGS,
	runCli,
	SCRIPTED_MODEL_ARGS,
	type Sandbox,
	startModelServer,
	writeScriptedProvider,
	writeSettings,
} from "./helpers/feature-host-cli.ts";

/**
 * A print run whose command ran in the command sandbox exits once its answer is printed: the sandbox library's proxy and
 * macOS log monitor (a `log stream` child) are stopped when the session ends, instead of keeping the process alive.
 */
let box: Sandbox | undefined;
let server: ModelServer | undefined;

afterEach(async () => {
	await server?.close();
	box?.cleanup();
	box = undefined;
	server = undefined;
});

describe.runIf(process.platform === "darwin")("a print run with sandbox.mode on", () => {
	it("runs its command sandboxed, prints the answer and exits", async () => {
		box = createSandbox();
		server = await startModelServer([{ tool: "bash", args: { command: "echo sandboxed-ran" } }, { text: "answered" }]);
		writeScriptedProvider(box, server);
		writeSettings(box, { sandbox: { mode: "on" }, retry: { enabled: false } });
		const started = Date.now();
		const result = await runCli(box, [...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS, "-p", "run it"], 30_000);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("answered");
		expect(JSON.stringify(server.requests)).toContain("sandboxed-ran");
		expect(Date.now() - started).toBeLessThan(30_000);
	}, 60_000);
});
