import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCliInvocation, VERSION } from "../src/config.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { RPC_PROTOCOL_VERSION } from "../src/modes/rpc/session-identity.ts";
import { leadsProcessGroup } from "../src/utils/shell.ts";
import {
	createSandbox,
	observeSessions,
	stopChildTree,
	QUIET_ARGS,
	SCRIPTED_MODEL_ARGS,
	type ModelServer,
	type Sandbox,
	startModelServer,
	writeScriptedProvider,
} from "./helpers/feature-host-cli.ts";

/** The real RPC and print processes, for what only shows at the process boundary. */
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

type WireRecord = { type: string; [key: string]: unknown };

function cli(box: Sandbox, args: string[]) {
	const invocation = getCliInvocation();
	const child = spawn(invocation.command, [...invocation.prefix, ...args], {
		cwd: box.project,
		env: box.env,
		stdio: "pipe",
		detached: leadsProcessGroup(),
	});
	children.push(child);
	const records: WireRecord[] = [];
	const buffers = { out: "", err: "" };
	child.stdout.on("error", () => {});
	child.stdin.on("error", () => {});
	child.stdout.on("data", (chunk: Buffer) => {
		buffers.out += chunk.toString();
		const lines = buffers.out.split("\n");
		buffers.out = lines.pop() ?? "";
		for (const line of lines) if (line.startsWith("{")) records.push(JSON.parse(line) as WireRecord);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		buffers.err += chunk.toString();
	});
	return {
		child,
		records,
		stderr: () => buffers.err,
		send: (command: object) => child.stdin.write(`${JSON.stringify(command)}\n`),
		closed: () => once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>,
	};
}

async function scripted(replies: Parameters<typeof startModelServer>[0], env: Strings = {}) {
	sandbox = createSandbox(env);
	server = await startModelServer(replies);
	writeScriptedProvider(sandbox, server);
	return sandbox;
}
type Strings = { [key: string]: string };

const response = (records: WireRecord[], id: string) => records.find((r) => r.type === "response" && r.id === id);

describe("RPC startup records", () => {
	it("opens with rpc_ready naming the protocol, the version and the session, and get_state repeats the versions", async () => {
		const box = await scripted([{ text: "unused" }]);
		const rpc = cli(box, ["--mode", "rpc", ...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS]);
		rpc.send({ id: "s", type: "get_state" });
		await vi.waitFor(() => expect(response(rpc.records, "s"), rpc.stderr()).toBeDefined(), { timeout: 45_000 });
		const state = response(rpc.records, "s")?.data as Strings;
		expect(rpc.records[0]).toEqual({
			type: "rpc_ready",
			protocolVersion: RPC_PROTOCOL_VERSION,
			version: VERSION,
			sessionId: state.sessionId,
		});
		expect(state).toMatchObject({ protocolVersion: RPC_PROTOCOL_VERSION, version: VERSION });
		expect(rpc.records.filter((record) => record.type === "rpc_ready")).toHaveLength(1);
		rpc.child.stdin.end();
		await rpc.closed();
	});

	it("hands rpc_ready to the client's onReady and not to its event listeners", async () => {
		const box = await scripted([{ text: "unused" }]);
		const invocation = getCliInvocation();
		const ready = vi.fn();
		const events: string[] = [];
		const client = new RpcClient({
			ownProcessTree: true,
			invocation: { command: invocation.command, args: invocation.prefix },
			cwd: box.project,
			args: [...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS],
			env: box.env,
			onReady: ready,
		});
		client.onEvent((event) => events.push(event.type));
		try {
			await client.start();
			const state = await client.getState();
			expect(ready).toHaveBeenCalledWith(expect.objectContaining({ sessionId: state.sessionId, version: VERSION }));
			expect(events).not.toContain("rpc_ready");
		} finally {
			await client.stop();
		}
	});

	it("says on stderr that the default mode runs everything unasked", async () => {
		const box = await scripted([{ text: "unused" }], { OCTOCODE_PERMISSION: "full" });
		const rpc = cli(box, ["--mode", "rpc", ...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS]);
		rpc.send({ id: "s", type: "get_state" });
		await vi.waitFor(() => expect(response(rpc.records, "s"), rpc.stderr()).toBeDefined(), { timeout: 45_000 });
		expect(rpc.stderr()).toContain("permission mode full");
		rpc.child.stdin.end();
		await rpc.closed();
	});

	it("marks a prompt refused for missing credentials, for a raw driver and for RpcClient", async () => {
		sandbox = createSandbox();
		const rpc = cli(sandbox, ["--mode", "rpc", ...QUIET_ARGS]);
		rpc.send({ id: "p", type: "prompt", message: "hello" });
		await vi.waitFor(() => expect(response(rpc.records, "p"), rpc.stderr()).toBeDefined(), { timeout: 45_000 });
		expect(response(rpc.records, "p")).toMatchObject({
			success: false,
			authRequired: true,
			error: expect.stringContaining("No usable credentials"),
		});
		rpc.child.stdin.end();
		await rpc.closed();

		const invocation = getCliInvocation();
		const client = new RpcClient({
			ownProcessTree: true,
			invocation: { command: invocation.command, args: invocation.prefix },
			cwd: sandbox.project,
			args: QUIET_ARGS,
			env: sandbox.env,
		});
		try {
			await client.start();
			await expect(client.prompt("hello")).rejects.toMatchObject({ authRequired: true });
		} finally {
			await client.stop();
		}
	}, 90_000);
});

describe("--no-dialogs", () => {
	it("refuses an ask as a headless run does, instead of waiting for an answer that never comes", async () => {
		const box = await scripted(
			[{ tool: "bash", args: { command: "echo ran > ran.txt", reason: "test" } }, { text: "finished" }],
			{ OCTOCODE_PERMISSION: "manual" },
		);
		const rpc = cli(box, ["--mode", "rpc", "--no-dialogs", ...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS]);
		rpc.send({ id: "p", type: "prompt", message: "run the command" });
		await vi.waitFor(
			() =>
				expect(
					rpc.records.some((record) => record.type === "agent_settled"),
					rpc.stderr(),
				).toBe(true),
			{ timeout: 45_000 },
		);
		expect(rpc.records.filter((record) => record.type === "extension_ui_request")).toEqual([]);
		expect(existsSync(join(box.project, "ran.txt"))).toBe(false);
		const end = rpc.records.find((record) => record.type === "tool_execution_end") as WireRecord;
		expect(end.isError).toBe(true);
		rpc.child.stdin.end();
		await rpc.closed();
	});
});

describe("set_auto_retry", () => {
	it("writes nothing to the user's settings", async () => {
		const box = await scripted([{ text: "unused" }]);
		const settings = join(box.agentDir, "settings.json");
		const rpc = cli(box, ["--mode", "rpc", ...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS]);
		rpc.send({ id: "r", type: "set_auto_retry", enabled: false });
		await vi.waitFor(() => expect(response(rpc.records, "r"), rpc.stderr()).toMatchObject({ success: true }), {
			timeout: 45_000,
		});
		rpc.child.stdin.end();
		await rpc.closed();
		const saved = existsSync(settings) ? (JSON.parse(readFileSync(settings, "utf8")) as object) : {};
		expect(saved).not.toHaveProperty("retry");
	});
});

describe.skipIf(process.platform === "win32")("a closed stdout", () => {
	const expectReleased = async (run: ReturnType<typeof cli>, sessions: ReturnType<typeof observeSessions>) => {
		const [code] = await run.closed();
		expect(code, run.stderr()).toBe(1);
		expect(run.stderr()).toContain("stdout failed");
		expect(run.stderr()).not.toContain("Emitted 'error'");
		expect(sessions.started()).toHaveLength(1);
		expect(sessions.ended()).toEqual(sessions.started());
	};

	it("RPC mode releases the session and exits 1 with no stack", async () => {
		const box = await scripted([{ text: "unused" }]);
		const sessions = observeSessions(box);
		const run = cli(box, ["--mode", "rpc", ...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS]);
		run.send({ id: "s", type: "get_state" });
		await vi.waitFor(() => expect(response(run.records, "s"), run.stderr()).toBeDefined(), { timeout: 45_000 });
		run.child.stdout.destroy();
		run.send({ id: "t", type: "get_state" });
		await expectReleased(run, sessions);
	}, 90_000);

	it("JSON mode releases the session and exits 1 with no stack", async () => {
		const box = await scripted([{ text: "the answer" }]);
		const sessions = observeSessions(box);
		server?.hold();
		const run = cli(box, ["--mode", "json", "--no-stdin", "hello", ...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS]);
		await vi.waitFor(
			() =>
				expect(
					run.records.some((record) => record.type === "agent_start"),
					run.stderr(),
				).toBe(true),
			{ timeout: 45_000 },
		);
		run.child.stdout.destroy();
		server?.release();
		await expectReleased(run, sessions);
	}, 90_000);
});

describe("print mode stdin", () => {
	it("--no-stdin runs with a pipe its parent leaves open", async () => {
		const box = await scripted([{ text: "the answer" }]);
		const run = cli(box, ["-p", "--no-stdin", "hello", ...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS]);
		const [code] = await run.closed();
		expect(code, run.stderr()).toBe(0);
	}, 60_000);
});
