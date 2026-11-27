import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
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

/** A stdio MCP server that lists one tool, `echo`. */
const MCP_FIXTURE = `import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const result = request.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : request.method === "tools/list"
      ? { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }] }
      : { content: [{ type: "text", text: "echoed" }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`;

it("starts the ACP worker for session/new with a client stdio MCP server and lists that server's tool to the model", async () => {
	sandbox = createSandbox();
	server = await startModelServer([{ text: "mcp listed" }]);
	writeScriptedProvider(sandbox, server);
	const fixture = join(sandbox.directory, "mcp-fixture.mjs");
	writeFileSync(fixture, MCP_FIXTURE);
	const invocation = getCliInvocation();
	const child = spawn(
		invocation.command,
		[...invocation.prefix, "--mode", "acp", ...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS],
		{
			cwd: sandbox.project,
			stdio: ["pipe", "pipe", "pipe"],
			env: sandbox.env,
		},
	);
	let diagnostics = "";
	child.stderr.on("data", (part) => (diagnostics += part.toString()));
	const exited = once(child, "close");
	const connection = client({ name: "feature-host-acp-mcp-test" }).connect(
		ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
	);
	try {
		await connection.agent.request(methods.agent.initialize, {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		const session = await connection.agent.request(methods.agent.session.new, {
			cwd: sandbox.project,
			mcpServers: [{ name: "client fixture", command: process.execPath, args: [fixture], env: [] }],
		});
		expect(session.sessionId, diagnostics).toBeTruthy();
		await expect(
			connection.agent.request(methods.agent.session.prompt, {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "which tools exist" }],
			}),
		).resolves.toMatchObject({ stopReason: "end_turn" });
		const request = server.requests[0] as { tools?: Array<{ function: { name: string } }> };
		const names = (request.tools ?? []).map((tool) => tool.function.name);
		expect(
			names.filter((name) => /^mcp__acp_[0-9a-f]{16}__echo$/.test(name)),
			diagnostics,
		).toHaveLength(1);
		expect(diagnostics).not.toContain("unavailable");
	} finally {
		connection.close();
		child.stdin.end();
		await exited;
	}
}, 90_000);
