import { afterEach, expect, it, vi } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { agentText, startAcpAgent, type AcpAgent } from "./helpers/feature-host-acp.ts";
import {
	createSandbox,
	type ModelServer,
	type Sandbox,
	startModelServer,
	writeScriptedProvider,
} from "./helpers/feature-host-cli.ts";

let sandbox: Sandbox;
let server: ModelServer | undefined;
let agent: AcpAgent | undefined;

afterEach(async () => {
	server?.release();
	await agent?.stop();
	await server?.close();
	sandbox?.cleanup();
	agent = undefined;
	server = undefined;
});

/** `/plan <text>` is a native command that starts a model run itself (`sendUserMessage`), as a prompt template would not. */
it("waits for a command-started model run and delivers its response before completing the ACP prompt", async () => {
	sandbox = createSandbox();
	server = await startModelServer([{ text: "plain reply" }, { text: "command-run reply" }]);
	writeScriptedProvider(sandbox, server);
	agent = startAcpAgent(sandbox);
	await agent.initialize();
	const sessionId = await agent.newSession();
	const prompt = (text: string) => agent!.prompt(sessionId, text);
	const diagnostics = () => agent!.diagnostics();

	await expect(prompt("plain prompt"), diagnostics()).resolves.toMatchObject({ stopReason: "end_turn" });
	expect(agentText(agent.updates), diagnostics()).toContain("plain reply");
	agent.updates.length = 0;

	// The command returns at once; the model run it started is still waiting for its reply.
	const before = server.requests.length;
	server.hold();
	let completed = false;
	const command = prompt("/plan outline the work").finally(() => (completed = true));
	await vi.waitFor(() => expect(server!.requests.length, diagnostics()).toBe(before + 1), { timeout: 30_000 });
	await new Promise((resolve) => setTimeout(resolve, 500));
	expect(completed, "the ACP prompt waits for the model run the command started").toBe(false);
	server.release();
	await expect(command, diagnostics()).resolves.toMatchObject({ stopReason: "end_turn" });
	expect(agentText(agent.updates), "the reply arrived before the prompt completed").toContain("command-run reply");

	// A cancel reaches the model run, which the host aborts.
	const cancelBefore = server.requests.length;
	server.hold();
	const cancelled = prompt("cancel this model");
	await vi.waitFor(() => expect(server!.requests.length, diagnostics()).toBe(cancelBefore + 1), { timeout: 30_000 });
	await agent.connection.agent.notify(methods.agent.session.cancel, { sessionId });
	await expect(cancelled).resolves.toMatchObject({ stopReason: "cancelled" });
	server.release();
	await expect(prompt("after cancellation"), diagnostics()).resolves.toMatchObject({ stopReason: "end_turn" });
}, 120_000);
