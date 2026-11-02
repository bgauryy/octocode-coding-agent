import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type SessionNotification } from "@agentclientprotocol/sdk";
import { afterEach, expect, it } from "vitest";
import { getCliInvocation } from "../src/config.ts";
import {
	createSandbox,
	QUIET_ARGS,
	SCRIPTED_MODEL_ARGS,
	type ModelServer,
	type Sandbox,
	startModelServer,
	writeScriptedProvider,
} from "./helpers/feature-host-cli.ts";

let sandbox: Sandbox;
let server: ModelServer | undefined;

afterEach(async () => {
	await server?.close();
	sandbox?.cleanup();
	server = undefined;
});

it("serves session/new and a prompt through the native feature set under --mode acp", async () => {
	sandbox = createSandbox();
	server = await startModelServer([{ text: "acp scripted answer" }]);
	writeScriptedProvider(sandbox, server);
	const invocation = getCliInvocation();
	// An older parent also passes these; they must not stop the server from starting.
	const child = spawn(
		invocation.command,
		[
			...invocation.prefix,
			"--mode",
			"acp",
			"--no-extensions",
			"-e",
			"builtin:mcp",
			...QUIET_ARGS,
			...SCRIPTED_MODEL_ARGS,
		],
		{ cwd: sandbox.project, stdio: ["pipe", "pipe", "pipe"], env: sandbox.env },
	);
	let diagnostics = "";
	child.stderr.on("data", (part) => (diagnostics += part.toString()));
	const exited = once(child, "close");
	const updates: SessionNotification[] = [];
	const connection = client({ name: "feature-host-acp-test" })
		.onNotification(methods.client.session.update, ({ params }) => {
			updates.push(params);
		})
		.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
	try {
		await connection.agent.request(methods.agent.initialize, {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		const session = await connection.agent.request(methods.agent.session.new, { cwd: sandbox.project, mcpServers: [] });
		expect(session.sessionId, diagnostics).toBeTruthy();
		await expect(
			connection.agent.request(methods.agent.session.prompt, {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "say hello" }],
			}),
		).resolves.toMatchObject({ stopReason: "end_turn" });
		const text = updates
			.flatMap(({ update }) =>
				update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : [],
			)
			.join("");
		expect(text).toContain("acp scripted answer");
		expect(diagnostics).not.toContain("removed");
	} finally {
		connection.close();
		child.stdin.end();
		await exited;
	}
}, 90_000);
