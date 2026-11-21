import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCliInvocation } from "../src/config.ts";
import { leadsProcessGroup } from "../src/utils/shell.ts";
import {
	createSandbox,
	type ModelServer,
	QUIET_ARGS,
	SCRIPTED_MODEL_ARGS,
	type Sandbox,
	startModelServer,
	stopChildTree,
	writeScriptedProvider,
} from "./helpers/feature-host-cli.ts";

/** The real RPC process: which wire form its approvals take, and how many bytes its events repeat. */
let sandbox: Sandbox | undefined;
let server: ModelServer | undefined;
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
	await Promise.all(children.splice(0).map(stopChildTree));
	await server?.close();
	sandbox?.cleanup();
	sandbox = undefined;
	server = undefined;
});

type Wire = { type: string; [key: string]: unknown };

async function rpc(args: string[], replies: Parameters<typeof startModelServer>[0], env: Record<string, string> = {}) {
	sandbox = createSandbox(env);
	server = await startModelServer(replies);
	writeScriptedProvider(sandbox, server);
	const invocation = getCliInvocation();
	const child = spawn(
		invocation.command,
		[...invocation.prefix, "--mode", "rpc", ...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS, ...args],
		{ cwd: sandbox.project, env: sandbox.env, stdio: "pipe", detached: leadsProcessGroup() },
	);
	children.push(child);
	const records: Wire[] = [];
	let buffer = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) if (line.startsWith("{")) records.push(JSON.parse(line) as Wire);
	});
	child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
	child.stdin.on("error", () => {});
	const send = (command: object) => child.stdin.write(`${JSON.stringify(command)}\n`);
	const settled = () =>
		vi.waitFor(
			() =>
				expect(
					records.some((r) => r.type === "agent_settled"),
					stderr,
				).toBe(true),
			{ timeout: 45_000 },
		);
	return { box: sandbox, records, send, settled, stderr: () => stderr };
}

const runCommand = [{ tool: "bash", args: { command: "echo ran > ran.txt" } }, { text: "finished" }];

describe("--rpc-ask", () => {
	it("sends an approval as one ask request that answers with replies, and a refusal stops the command", async () => {
		const run = await rpc(["--rpc-ask"], runCommand, { OCTOCODE_PERMISSION: "manual" });
		run.send({ id: "p", type: "prompt", message: "run it" });
		await vi.waitFor(
			() =>
				expect(
					run.records.some((r) => r.method === "ask"),
					run.stderr(),
				).toBe(true),
			{
				timeout: 45_000,
			},
		);
		const requests = run.records.filter(
			(r) => r.type === "extension_ui_request" && (r.method === "ask" || r.method === "select"),
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ method: "ask", approval: true });
		run.send({ type: "extension_ui_response", id: requests[0].id, cancelled: true });
		await run.settled();
		expect(existsSync(join(run.box.project, "ran.txt"))).toBe(false);
	});

	it("without it sends the same approval as a select request carrying the permission identity", async () => {
		const run = await rpc([], runCommand, { OCTOCODE_PERMISSION: "manual" });
		run.send({ id: "p", type: "prompt", message: "run it" });
		await vi.waitFor(
			() =>
				expect(
					run.records.some((r) => r.method === "select"),
					run.stderr(),
				).toBe(true),
			{
				timeout: 45_000,
			},
		);
		const requests = run.records.filter(
			(r) => r.type === "extension_ui_request" && (r.method === "ask" || r.method === "select"),
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ method: "select", permission: { toolName: "bash" } });
		expect(requests.some((r) => r.method === "ask")).toBe(false);
		run.send({ type: "extension_ui_response", id: requests[0].id, cancelled: true });
		await run.settled();
		expect(existsSync(join(run.box.project, "ran.txt"))).toBe(false);
	});
});

describe("--rpc-lean-events", () => {
	const finish = async (args: string[]) => {
		const run = await rpc(args, [{ text: "lean answer" }]);
		run.send({ id: "p", type: "prompt", message: "hello" });
		await run.settled();
		return run.records;
	};

	it("refers to messages by role in agent_end and drops the assistant request trace from message_end", async () => {
		const records = await finish(["--rpc-lean-events"]);
		const end = { messages: records.find((r) => r.type === "agent_end")?.messages as Array<Record<string, unknown>> };
		const assistant = end.messages.find((m) => m.role === "assistant");
		expect(assistant).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(assistant).not.toHaveProperty("content");
		const finished = records.filter(
			(r) => r.type === "message_end" && (r.message as { role: string }).role === "assistant",
		);
		expect(JSON.stringify(finished)).toContain("lean answer");
		expect(finished[0].message).not.toHaveProperty("requestTrace");
	});

	it("without it agent_end repeats each message whole", async () => {
		const records = await finish([]);
		const end = { messages: records.find((r) => r.type === "agent_end")?.messages as Array<Record<string, unknown>> };
		expect(JSON.stringify(end.messages)).toContain("lean answer");
		expect(end.messages.find((m) => m.role === "assistant")).toHaveProperty("content");
	});
});
