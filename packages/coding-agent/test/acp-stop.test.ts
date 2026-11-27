import { once } from "node:events";
import { tmpdir } from "node:os";
import { relative } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startAcpAgent, type AcpAgent } from "./helpers/feature-host-acp.ts";
import { testCompileCacheDir } from "./helpers/compile-cache.ts";
import {
	createSandbox,
	type ModelServer,
	type Sandbox,
	startModelServer,
	writeScriptedProvider,
} from "./helpers/feature-host-cli.ts";

let sandbox: Sandbox | undefined;
let server: ModelServer | undefined;
let agent: AcpAgent | undefined;

afterEach(async () => {
	await agent?.stop();
	await server?.close();
	sandbox?.cleanup();
	agent = undefined;
	server = undefined;
	sandbox = undefined;
});

it("exits after a disconnect without an uncaught error, inside the ten-second worker bound", async () => {
	sandbox = createSandbox();
	server = await startModelServer([{ text: "answered" }]);
	writeScriptedProvider(sandbox, server);
	agent = startAcpAgent(sandbox);
	await agent.initialize();
	const sessionId = await agent.newSession();
	await agent.prompt(sessionId, "hello");
	const exit = once(agent.child, "exit");
	const started = performance.now();
	// The client closes both ends: a record still queued for it then fails to write, which ends only the wait for it.
	agent.connection.close();
	agent.child.stdin.end();
	await exit;
	const exitedAfter = performance.now() - started;
	await agent.exited;
	expect(agent.diagnostics()).not.toMatch(/EPIPE|triggerUncaughtException/);
	// Each worker gets ten seconds before it is killed (`docs/acp.md`); its own shutdown takes a fraction of that.
	expect(exitedAfter).toBeLessThan(10_000);
	agent = undefined;
});

// A process writes the compile cache entries it lacks when it exits, before it dies: about 5,700 for a cold start from
// source, which held an agent and its worker for seconds after their own shutdown when the suite loaded the machine.
it("starts agents with the suite's compile cache, which outlives the run's temporary directory", () => {
	sandbox = createSandbox();
	expect(sandbox.env.NODE_COMPILE_CACHE).toBe(testCompileCacheDir());
	expect(relative(tmpdir(), testCompileCacheDir()).startsWith("..")).toBe(true);
});
