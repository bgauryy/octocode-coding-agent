import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { expect, it } from "vitest";
import { getCliInvocation } from "../src/config.ts";
import { processAlive, processMatch, processStartTime, stopTree } from "../src/octocode/shared/process.ts";

it("stops every owned ACP worker before exiting when the client closes only its stdout reader", async () => {
	const directory = mkdtempSync(join(tmpdir(), "octocode-acp-output-close-"));
	const extension = join(directory, "lifecycle.mjs");
	const started = join(directory, "started.jsonl");
	const shutdown = join(directory, "shutdown.jsonl");
	writeFileSync(
		extension,
		`import { appendFileSync } from "node:fs";
export default function(api) {
  api.on("session_start", () => appendFileSync(${JSON.stringify(started)}, JSON.stringify({ pid: process.pid }) + "\\n"));
  api.on("input", () => ({ action: "handled" }));
  api.on("session_shutdown", async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    appendFileSync(${JSON.stringify(shutdown)}, JSON.stringify({ pid: process.pid }) + "\\n");
  });
}
`,
	);
	const invocation = getCliInvocation();
	const child = spawn(
		invocation.command,
		[
			...invocation.prefix,
			"--mode",
			"acp",
			"--no-mcp",
			"--no-builtin-tools",
			"--no-extensions",
			"--extension",
			extension,
			"--no-skills",
			"--no-context-files",
			"--offline",
			"--provider",
			"openai",
			"--model",
			"gpt-4o-mini",
		],
		{
			cwd: directory,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(process.platform === "win32" ? ";" : ":"),
				HOME: directory,
				USERPROFILE: directory,
				TMPDIR: tmpdir(),
				OCTOCODE_HOME: join(directory, "home"),
				OCTOCODE_CODING_AGENT_DIR: join(directory, "agent"),
				OCTOCODE_OFFLINE: "1",
				OCTOCODE_MCP: "0",
				OCTOCODE_MODELS_DEV: "0",
				OCTOCODE_API: "0",
			},
		},
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
	const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
	try {
		expect(
			await request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
			diagnostics,
		).toHaveProperty("result");
		const sessions: { sessionId: string }[] = [];
		for (let index = 0; index < 2; index++) {
			const response = await request("session/new", { cwd: directory, mcpServers: [] });
			expect(response, diagnostics).toHaveProperty("result");
			sessions.push(response.result as { sessionId: string });
		}
		for (const line of readFileSync(started, "utf8").trim().split("\n")) {
			const { pid } = JSON.parse(line) as { pid: number };
			workers.push({ pid, started: processStartTime(pid) });
		}
		expect(workers).toHaveLength(2);
		const readerClosed = once(child.stdout, "close");
		child.stdout.destroy();
		await readerClosed;
		child.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: ++nextId,
				method: "session/prompt",
				params: {
					sessionId: sessions[0].sessionId,
					prompt: [{ type: "text", text: "handled without model calls" }],
				},
			})}\n`,
		);
		const [code, signal] = await exited;
		expect({ code, signal }, diagnostics).toEqual({ code: 1, signal: null });
		const stopped = existsSync(shutdown)
			? readFileSync(shutdown, "utf8")
					.trim()
					.split("\n")
					.map((line) => (JSON.parse(line) as { pid: number }).pid)
			: [];
		expect(
			{ stopped: stopped.sort((a, b) => a - b), live: workers.filter(({ pid }) => processAlive(pid)) },
			diagnostics,
		).toEqual({
			stopped: workers.map(({ pid }) => pid).sort((a, b) => a - b),
			live: [],
		});
		expect(diagnostics).not.toContain("Unhandled 'error' event");
	} finally {
		clearTimeout(timer);
		child.stdin.destroy();
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
		for (const worker of workers) if (processMatch(worker.pid, worker.started) === "same") await stopTree(worker.pid);
		rmSync(directory, { recursive: true, force: true });
	}
}, 40_000);
