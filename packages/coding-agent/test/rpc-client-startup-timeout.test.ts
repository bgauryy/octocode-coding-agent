import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const roots: string[] = [];
const clients: RpcClient[] = [];
function worker(body: string, timeout = 300) {
	const root = mkdtempSync(join(tmpdir(), "rpc-startup-"));
	roots.push(root);
	const entry = join(root, "worker.mjs");
	const pid = join(root, "pid");
	writeFileSync(
		entry,
		`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pid)}, String(process.pid)); ${body}`,
	);
	const client = new RpcClient({
		invocation: { command: process.execPath, args: [entry] },
		startupTimeoutMs: timeout,
		ownProcessTree: true,
	});
	clients.push(client);
	return { client, pid };
}
afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.stop()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

it("times out a stalled worker and reaps it before rejecting", async () => {
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const { client, pid } = worker(`process.stderr.write('startup diagnostic'); process.stdin.resume();`);
	const result = client.start().then(
		() => "ready",
		(error: Error) => error.message,
	);
	const outcome = await Promise.race([
		result,
		new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 1500)),
	]);
	expect(outcome).toContain("startup diagnostic");
	expect(outcome).toMatch(/startup.*tim/i);
	const childPid = Number(readFileSync(pid, "utf8"));
	expect(() => process.kill(childPid, 0)).toThrow();
});

it("clears the deadline on readiness and allows a subsequent run", async () => {
	const { client } = worker(
		`process.stdout.write(JSON.stringify({type:'rpc_ready',sessionId:'s'})+'\\n'); process.stdin.resume();`,
		200,
	);
	const closed = vi.fn();
	client.onClose(closed);
	await client.start();
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(closed).not.toHaveBeenCalled();
	await client.stop();
	await client.start();
	expect(closed).toHaveBeenCalledTimes(1);
});

it("explicit stop wins before the deadline and reaps the worker", async () => {
	const { client, pid } = worker(`process.stdin.resume();`, 1000);
	const closed = vi.fn();
	client.onClose(closed);
	const start = expect(client.start()).rejects.toThrow("Agent process stopped");
	await vi.waitFor(() => expect(readFileSync(pid, "utf8")).toBeTruthy());
	const childPid = Number(readFileSync(pid, "utf8"));
	await Promise.all([client.stop(), client.stop(), start]);
	expect(() => process.kill(childPid, 0)).toThrow();
	expect(closed).toHaveBeenCalledTimes(1);
});

it.each([0, -1, 1.5, Infinity, NaN, 2_147_483_648, null])("rejects invalid startup timeout %s", async (value) => {
	const client = new RpcClient({ startupTimeoutMs: value as number });
	await expect(client.start()).rejects.toThrow("startupTimeoutMs must be an integer");
});

it("delivers the final buffered event after the worker exits but before stdout ends", async () => {
	const { client } = worker(
		`
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], {stdio:['ignore', process.stdout, 'ignore']}).unref();
process.stdout.write('{"type":"rpc_ready","sessionId":"s"}\\n');
process.stdout.write('{"type":"agent_settled","aborted":false}');
`,
		2000,
	);
	const order: string[] = [];
	client.onClose(() => order.push("close"));
	client.onEvent(() => order.push("event"));
	await client.start();
	await vi.waitFor(() => expect(order).toEqual(["close", "event"]), { timeout: 2000 });
});

it("ignores a buffered readiness record after worker exit", async () => {
	const root = mkdtempSync(join(tmpdir(), "rpc-ready-drain-"));
	roots.push(root);
	const entry = join(root, "worker.mjs");
	writeFileSync(
		entry,
		`
import {spawn} from 'node:child_process';
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], {stdio:['ignore', process.stdout, 'ignore']}).unref();
process.stdout.write('{"type":"rpc_ready","sessionId":"first"}\\n');
process.stdout.write('{"type":"rpc_ready","sessionId":"late"}');
`,
	);
	const ready = vi.fn();
	const client = new RpcClient({ invocation: { command: process.execPath, args: [entry] }, onReady: ready });
	clients.push(client);
	const closed = vi.fn();
	client.onClose(closed);
	await client.start();
	await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
	await new Promise((resolve) => setTimeout(resolve, 600));
	expect(ready).toHaveBeenCalledOnce();
	expect(ready.mock.calls[0][0].sessionId).toBe("first");
});

it("preserves the timeout error when a close listener concurrently stops the worker", async () => {
	const { client, pid } = worker(`process.stdin.resume();`);
	let shutdown: Promise<void> | undefined;
	const closed = vi.fn(() => {
		shutdown = client.stop();
	});
	client.onClose(closed);
	await expect(client.start()).rejects.toThrow(/startup timed out/i);
	await shutdown;
	expect(closed).toHaveBeenCalledTimes(1);
	expect(() => process.kill(Number(readFileSync(pid, "utf8")), 0)).toThrow();
});

it("allows retry after timeout reaps the stalled worker", async () => {
	const { client } = worker(
		`setTimeout(() => process.stdout.write('{"type":"rpc_ready"}\\n'), 500); process.stdin.resume();`,
		200,
	);
	const closed = vi.fn();
	client.onClose(closed);
	await expect(client.start()).rejects.toThrow(/startup timed out/i);
	await expect(client.start()).rejects.toThrow(/startup timed out/i);
	expect(closed).toHaveBeenCalledTimes(2);
});
