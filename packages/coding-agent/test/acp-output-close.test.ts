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
		for (const worker of workers) if (processMatch(worker.pid, worker.started) === "same") await stopTree(worker.pid);
	}
}, 60_000);
