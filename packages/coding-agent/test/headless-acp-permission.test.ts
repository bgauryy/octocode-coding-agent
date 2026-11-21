import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
	client,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	type RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { getCliInvocation } from "../src/config.ts";
import {
	createSandbox,
	type ModelServer,
	SCRIPTED_MODEL_ARGS,
	type Sandbox,
	startModelServer,
	stopChildTree,
	writeScriptedProvider,
} from "./helpers/feature-host-cli.ts";
import { leadsProcessGroup } from "../src/utils/shell.ts";

/** The real ACP process: `OCTOCODE_PERMISSION` decides whether a command reaches the client as a permission request. */
let sandbox: Sandbox | undefined;
let server: ModelServer | undefined;
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
	await stop?.();
	await server?.close();
	sandbox?.cleanup();
	sandbox = undefined;
	server = undefined;
	stop = undefined;
});

async function runPrompt(permission: string, answer: "reject" | "allow") {
	sandbox = createSandbox({ OCTOCODE_PERMISSION: permission, OCTOCODE_API_HTTP: "0", OCTOCODE_MEMORY_AUTO: "0" });
	server = await startModelServer([{ tool: "bash", args: { command: "echo ran > ran.txt" } }, { text: "finished" }]);
	writeScriptedProvider(sandbox, server);
	const invocation = getCliInvocation();
	const child = spawn(
		invocation.command,
		[
			...invocation.prefix,
			"--mode",
			"acp",
			"--no-mcp",
			"--no-skills",
			"--no-context-files",
			"--offline",
			...SCRIPTED_MODEL_ARGS,
		],
		{ cwd: sandbox.project, env: sandbox.env, stdio: ["pipe", "pipe", "pipe"], detached: leadsProcessGroup() },
	);
	stop = () => stopChildTree(child);
	let diagnostics = "";
	child.stderr.on("data", (chunk) => (diagnostics += chunk.toString()));
	const requests: RequestPermissionRequest[] = [];
	const connection = client({ name: "headless-acp-permission-test" })
		.onRequest(methods.client.session.requestPermission, ({ params }) => {
			requests.push(params);
			const wanted = params.options.find(
				(option) => option.kind === (answer === "reject" ? "reject_once" : "allow_once"),
			);
			return { outcome: wanted ? { outcome: "selected", optionId: wanted.optionId } : { outcome: "cancelled" } };
		})
		.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
	await connection.agent.request(methods.agent.initialize, {
		protocolVersion: PROTOCOL_VERSION,
		clientCapabilities: {},
	});
	const session = await connection.agent.request(methods.agent.session.new, { cwd: sandbox.project, mcpServers: [] });
	const result = await connection.agent.request(methods.agent.session.prompt, {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "run it" }],
	});
	return { requests, result, ran: existsSync(join(sandbox.project, "ran.txt")), diagnostics: () => diagnostics };
}

describe("OCTOCODE_PERMISSION for an ACP session", () => {
	it("manual sends the command to the client as a permission request, and a refusal keeps it from running", async () => {
		const run = await runPrompt("manual", "reject");
		expect(run.requests).toHaveLength(1);
		expect(JSON.stringify(run.requests[0])).toContain("ran.txt");
		expect(run.requests[0].toolCall.kind).toBe("execute");
		expect(run.ran).toBe(false);
		expect(run.result.stopReason).toBe("end_turn");
	}, 90_000);

	it("manual runs the command once the client allows it", async () => {
		const run = await runPrompt("manual", "allow");
		expect(run.requests).toHaveLength(1);
		expect(run.ran).toBe(true);
	}, 90_000);

	it("full asks the client nothing", async () => {
		const run = await runPrompt("full", "reject");
		expect(run.requests).toEqual([]);
		expect(run.ran).toBe(true);
	}, 90_000);
});
