import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const roots: string[] = [];
const clients: RpcClient[] = [];
function fixture(body: string): string {
	const root = mkdtempSync(join(tmpdir(), "octocode-rpc-lifecycle-"));
	roots.push(root);
	const entry = join(root, "child.mjs");
	writeFileSync(
		entry,
		`import { createInterface } from "node:readline";
const output = value => process.stdout.write(JSON.stringify(value) + "\\n");
const reply = (command, data) => output({type:"response", id:command.id, command:command.type, success:true, data});
${body}
`,
	);
	return entry;
}
function client(body: string): RpcClient {
	const result = new RpcClient({ invocation: { command: process.execPath, args: [fixture(body)] } });
	clients.push(result);
	return result;
}
afterEach(async () => {
	await Promise.all(clients.splice(0).map((instance) => instance.stop()));
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RPC worker lifecycle", () => {
	it("uses an explicit executable prefix while preserving RPC and configured CLI arguments", async () => {
		const entry = fixture(`createInterface({input:process.stdin}).on("line", line => {
const command = JSON.parse(line); reply(command, {argv:process.argv.slice(2)});
});`);
		const instance = new RpcClient({
			invocation: { command: process.execPath, args: [entry, "prefix-argument"] },
			cliPath: "/must-not-be-used.mjs",
			provider: "test-provider",
			model: "test-model",
			args: ["--no-mcp"],
		});
		clients.push(instance);
		await instance.start();
		await expect(instance.getState()).resolves.toMatchObject({
			argv: ["prefix-argument", "--mode", "rpc", "--provider", "test-provider", "--model", "test-model", "--no-mcp"],
		});
	});

	it("reports child death once, rejects requests and idle waiters, and reports it to late subscribers", async () => {
		const instance = client(`process.stdin.once("data", () => process.exit(43)); process.stdin.resume();`);
		const closed = vi.fn();
		instance.onClose(closed);
		await instance.start();
		const idle = expect(instance.waitForIdle()).rejects.toThrow("code=43");
		const events = expect(instance.collectEvents()).rejects.toThrow("code=43");
		await expect(instance.getCommands()).rejects.toThrow("code=43");
		await Promise.all([idle, events]);
		const late = vi.fn();
		instance.onClose(late);
		await instance.stop();
		expect(closed).toHaveBeenCalledTimes(1);
		expect(late).toHaveBeenCalledTimes(1);
		expect(late.mock.calls[0][0]).toBe(closed.mock.calls[0][0]);
		await expect(instance.collectEvents()).rejects.toThrow("code=43");
	});

	it("settles pending work on concurrent stop and allows a new run without an old shutdown timer", async () => {
		const instance = client(`createInterface({input:process.stdin}).on("line", line => {
const command = JSON.parse(line); if (command.type === "get_state") reply(command, {ready:true});
});`);
		const closed = vi.fn();
		instance.onClose(closed);
		await instance.start();
		await instance.getState();
		const pending = expect(instance.compact()).rejects.toThrow("Agent process stopped");
		const idle = expect(instance.waitForIdle()).rejects.toThrow("Agent process stopped");
		await Promise.all([instance.stop(), instance.stop(), pending, idle]);
		expect(closed).toHaveBeenCalledTimes(1);
		await instance.start();
		await expect(instance.getState()).resolves.toMatchObject({ ready: true });
		await instance.stop();
		expect(closed).toHaveBeenCalledTimes(2);
	});

	it("escalates a child that ignores TERM and clears the completed run", async () => {
		if (process.platform === "win32") return;
		const instance = client(`process.on("SIGTERM", () => {});
createInterface({input:process.stdin}).on("line", line => reply(JSON.parse(line), {ready:true}));`);
		await instance.start();
		await instance.getState();
		await instance.stop();
		await expect(instance.getState()).rejects.toThrow("Client not started");
	});

	it("retains only a bounded stderr tail and still forwards every diagnostic chunk", async () => {
		const forwarded: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			forwarded.push(String(chunk));
			return true;
		});
		const instance = client(`createInterface({input:process.stdin}).on("line", line => {
const command = JSON.parse(line);
process.stderr.write("a".repeat(100000) + "END", () => reply(command, {}));
});`);
		await instance.start();
		await instance.getState();
		expect(instance.getStderr()).toHaveLength(65_536);
		expect(instance.getStderr().endsWith("END")).toBe(true);
		expect(forwarded.join("")).toHaveLength(100_003);
	});

	it("keeps private startup identity frames out of public events and preserves extension errors", async () => {
		const identity = vi.fn();
		const event = vi.fn();
		const entry = fixture(`output({type:"rpc_session_identity",sessionId:7});
output({type:"rpc_session_identity",sessionId:"canonical-id"});
output({type:"extension_error",extensionPath:"command:test",event:"command",error:"refused"});
process.stdin.resume();`);
		const instance = new RpcClient({
			invocation: { command: process.execPath, args: [entry] },
			onSessionIdentity: identity,
		});
		clients.push(instance);
		instance.onEvent(event);
		await instance.start();
		// start() waits a fixed 100ms, which a loaded machine can spend before the child writes; wait for its last frame.
		await vi.waitFor(() => expect(event).toHaveBeenCalled(), { timeout: 10_000 });
		expect(identity).toHaveBeenCalledExactlyOnceWith("canonical-id");
		expect(event).toHaveBeenCalledExactlyOnceWith({
			type: "extension_error",
			extensionPath: "command:test",
			event: "command",
			error: "refused",
		});
	});

	it("reports a spawn failure once and can stop a process that never obtained a PID", async () => {
		const instance = new RpcClient({ invocation: { command: "/missing-octocode-rpc-executable", args: [] } });
		clients.push(instance);
		const closed = vi.fn();
		instance.onClose(closed);
		await expect(instance.start()).rejects.toThrow("ENOENT");
		await instance.stop();
		expect(closed).toHaveBeenCalledTimes(1);
	});
});
