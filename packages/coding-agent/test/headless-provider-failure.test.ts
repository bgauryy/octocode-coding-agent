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

/** The real print and JSON processes against a model endpoint that fails on demand. */
let sandbox: Sandbox | undefined;
let server: ModelServer | undefined;

afterEach(async () => {
	await server?.close();
	sandbox?.cleanup();
	sandbox = undefined;
	server = undefined;
});

async function failing(replies: Parameters<typeof startModelServer>[0]) {
	sandbox = createSandbox();
	server = await startModelServer(replies);
	writeScriptedProvider(sandbox, server);
	writeSettings(sandbox, { retry: { enabled: false } });
	return sandbox;
}

describe("a provider failure in a headless run", () => {
	it.each([
		[401, "scripted key rejected"],
		[400, "scripted request refused"],
	])(
		"exits 1 in text mode on HTTP %i, names the reason on stderr and prints no answer",
		async (status, error) => {
			const box = await failing([{ status, error }]);
			const result = await runCli(box, [...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS, "-p", "hello"]);
			expect(result.code, result.stderr).toBe(1);
			expect(result.stderr).toContain(error);
			expect(result.stdout.trim()).toBe("");
		},
		90_000,
	);

	it("exits 1 in JSON mode and ends the event stream with an agent_end whose last message failed", async () => {
		const box = await failing([{ status: 400, error: "scripted request refused" }]);
		const result = await runCli(box, [...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS, "--mode", "json", "-p", "hello"]);
		expect(result.code, result.stderr).toBe(1);
		const events = result.stdout
			.split("\n")
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line) as { type: string; messages?: Array<{ role: string; stopReason?: string }> });
		const end = events.findLast((event) => event.type === "agent_end");
		expect(end?.messages?.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	}, 90_000);

	it("exits 1 when a later prompt succeeds after an earlier one failed", async () => {
		const box = await failing([{ status: 400, error: "first refused" }, { text: "second answer" }]);
		const result = await runCli(box, [...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS, "-p", "one", "two"]);
		expect(result.code, result.stderr).toBe(1);
		expect(result.stderr).toContain("first refused");
	}, 90_000);

	it("exits 0 for the same prompt when the provider answers", async () => {
		const box = await failing([{ text: "fine" }]);
		const result = await runCli(box, [...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS, "-p", "hello"]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("fine");
	}, 90_000);
});
