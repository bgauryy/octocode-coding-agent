import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { processAlive } from "../src/octocode/shared/process.ts";
import { signalTree } from "../src/utils/process-tree.ts";

const roots: string[] = [];
const clients: RpcClient[] = [];
const pids: number[] = [];

function fixture(body: string): { client: RpcClient; root: string } {
	const root = mkdtempSync(join(tmpdir(), "octocode-rpc-cleanup-"));
	roots.push(root);
	const entry = join(root, "worker.mjs");
	writeFileSync(
		entry,
		`import { createInterface } from "node:readline";
const reply = (command, data) => process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, success:true, data}) + "\\n");
${body}
`,
	);
	const client = new RpcClient({ ownProcessTree: true, invocation: { command: process.execPath, args: [entry] } });
	clients.push(client);
	return { client, root };
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.stop()));
	for (const pid of pids.splice(0)) signalTree(pid, "SIGKILL");
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("owned RPC process cleanup", () => {
	it("allows native cleanup that takes longer than the legacy one-second shutdown", async () => {
		const { client, root } = fixture(`import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => setTimeout(() => {
  writeFileSync(new URL("./cleaned", import.meta.url), "finished");
  process.exit(0);
}, 1200));
createInterface({input:process.stdin}).on("line", line => reply(JSON.parse(line), {}));`);
		await client.start();
		await client.getState();
		await client.stop();
		expect(readFileSync(join(root, "cleaned"), "utf8")).toBe("finished");
	});

	it("kills a worker and its same-group child when both ignore TERM", async () => {
		const { client } = fixture(`import { spawn } from "node:child_process";
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);'], {stdio:["ignore", "ignore", "ignore", "ipc"]});
const ready = new Promise(resolve => child.once("message", resolve));
createInterface({input:process.stdin}).on("line", async line => {
  await ready;
  reply(JSON.parse(line), {sessionId:String(process.pid), sessionFile:String(child.pid)});
});`);
		await client.start();
		const state = await client.getState();
		const workerPid = Number(state.sessionId);
		const childPid = Number(state.sessionFile);
		pids.push(workerPid, childPid);
		expect(processAlive(workerPid)).toBe(true);
		expect(processAlive(childPid)).toBe(true);
		await client.stop();
		expect(processAlive(workerPid)).toBe(false);
		expect(processAlive(childPid)).toBe(false);
		await expect(client.getState()).rejects.toThrow("Client not started");
	}, 30_000);

	it("does not spawn a worker after stop interrupts process-tree preparation", async () => {
		const { client } = fixture("process.stdin.resume();");
		const starting = expect(client.start()).rejects.toThrow("Agent process stopped");
		await client.stop();
		await starting;
		await expect(client.getState()).rejects.toThrow("Client not started");
	});
});
