import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { getCliInvocation } from "../src/config.ts";
import { processAlive, processMatch, processStartTime, stopTree } from "../src/octocode/shared/process.ts";
import {
	createSandbox,
	observeSessions,
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

it("stops every owned ACP worker before exiting when the client closes only its stdout reader", async () => {
	sandbox = createSandbox();
	const sessions = observeSessions(sandbox);
	server = await startModelServer([{ text: "answered after the reader closed" }]);
	writeScriptedProvider(sandbox, server);
	const invocation = getCliInvocation();
	const child = spawn(
		invocation.command,
		[...invocation.prefix, "--mode", "acp", ...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS],
		{ cwd: sandbox.project, stdio: ["pipe", "pipe", "pipe"], env: sandbox.env },
	);
	let diagnostics = "";
	child.stderr.setEncoding("utf8").on("data", (chunk) => {
		diagnostics += chunk;
	});
	child.stdin.on("error", () => {});
	const exited = once(child, "close");
	const pending = new Map<number, (message: Record<string, unknown>) => void>();
	let buffered = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => {
		buffered += chunk;
		while (buffered.includes("\n")) {
			const index = buffered.indexOf("\n");
			const message = JSON.parse(buffered.slice(0, index)) as Record<string, unknown>;
			buffered = buffered.slice(index + 1);
			if (typeof message.id === "number") pending.get(message.id)?.(message);
		}
	});
	let nextId = 0;
	const request = (method: string, params: Record<string, unknown>) => {
		const id = ++nextId;
		return new Promise<Record<string, unknown>>((resolve) => {
			pending.set(id, resolve);
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	};
	const workers: { pid: number; started: string | undefined }[] = [];
	const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
	try {
		expect(
			await request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
			diagnostics,
		).toHaveProperty("result");
		const created: { sessionId: string }[] = [];
		for (let index = 0; index < 2; index++) {
			const response = await request("session/new", { cwd: sandbox.project, mcpServers: [] });
			expect(response, diagnostics).toHaveProperty("result");
			created.push(response.result as { sessionId: string });
		}
		// The SessionStart hook does not hold session creation back, so it records its pid shortly after.
		await vi.waitFor(() => expect(new Set(sessions.started()).size, diagnostics).toBe(2), { timeout: 20_000 });
		for (const pid of new Set(sessions.started())) workers.push({ pid, started: processStartTime(pid) });
		const readerClosed = once(child.stdout, "close");
		child.stdout.destroy();
		await readerClosed;
		child.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: ++nextId,
				method: "session/prompt",
				params: {
					sessionId: created[0].sessionId,
					prompt: [{ type: "text", text: "answered while nobody reads" }],
				},
			})}\n`,
		);
		const [code, signal] = await exited;
		expect({ code, signal }, diagnostics).toEqual({ code: 1, signal: null });
		expect(
			{
				stopped: [...new Set(sessions.ended())].sort((a, b) => a - b),
				live: workers.filter(({ pid }) => processAlive(pid)),
			},
			diagnostics,
		).toEqual({ stopped: workers.map(({ pid }) => pid).sort((a, b) => a - b), live: [] });
		expect(diagnostics).not.toContain("Unhandled 'error' event");
	} finally {
		clearTimeout(timer);
		child.stdin.destroy();
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
		for (const worker of workers)
			if ((await processMatch(worker.pid, worker.started)) === "same") await stopTree(worker.pid);
	}
}, 60_000);

it.each(["SIGTERM", "SIGINT"] as const)(
	"exits on %s within a bound while the client holds stdout open but stops reading",
	async (signal) => {
		sandbox = createSandbox();
		const invocation = getCliInvocation();
		const child = spawn(invocation.command, [...invocation.prefix, "--mode", "acp", ...QUIET_ARGS], {
			cwd: sandbox.project,
			stdio: ["pipe", "pipe", "pipe"],
			env: sandbox.env,
		});
		let diagnostics = "";
		child.stderr.setEncoding("utf8").on("data", (chunk) => {
			diagnostics += chunk;
		});
		child.stdin.on("error", () => {});
		const exited = once(child, "close");
		const first = once(child.stdout, "data");
		const initialize = (id: number) =>
			`${JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} } })}\n`;
		const killer = setTimeout(() => child.kill("SIGKILL"), 40_000);
		try {
			child.stdin.write(initialize(0));
			await first;
			child.stdout.pause();
			// Far more responses than a pipe holds, so the child's write callback cannot fire.
			child.stdin.write(Array.from({ length: 3_000 }, (_, index) => initialize(index + 1)).join(""));
			await new Promise((resolve) => setTimeout(resolve, 3_000));
			const signalled = Date.now();
			child.kill(signal);
			const [code, killedBy] = await exited;
			expect({ code, killedBy, boundedMs: Date.now() - signalled < 15_000 }, diagnostics).toEqual({
				code: signal === "SIGINT" ? 130 : 143,
				killedBy: null,
				boundedMs: true,
			});
		} finally {
			clearTimeout(killer);
			child.stdin.destroy();
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
		}
	},
	60_000,
);
