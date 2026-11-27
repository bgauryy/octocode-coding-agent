import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
process.stdout.write(JSON.stringify({type:"rpc_ready",protocolVersion:1,version:"test",sessionId:"test"}) + "\\n");
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

	it("reports a listener's exception as its own failure and still tells later listeners", async () => {
		const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const instance = client(`output({type:"agent_settled", aborted:false});
process.stdin.resume();`);
		const later = vi.fn();
		instance.onEvent(() => {
			throw new Error("listener bug");
		});
		instance.onEvent(later);
		await instance.start();
		await vi.waitFor(() => expect(later).toHaveBeenCalledOnce());
		const reported = String(error.mock.calls[0]?.[0]);
		expect(reported).toContain("RPC event listener failed");
		expect(reported).toContain("listener bug");
	});

	it("skips a line that is not JSON without reporting it", async () => {
		const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const instance = client(`process.stdout.write("not json\\n");
output({type:"agent_settled", aborted:false});
process.stdin.resume();`);
		const seen = vi.fn();
		instance.onEvent(seen);
		await instance.start();
		await vi.waitFor(() => expect(seen).toHaveBeenCalledOnce());
		expect(error).not.toHaveBeenCalled();
	});

	it("surfaces a failure with no id, to its listener and in a command's timeout", async () => {
		const parse = {
			type: "response",
			command: "parse",
			success: false,
			error: "Failed to parse command: bad line",
		};
		const entry = fixture(`createInterface({input:process.stdin}).on("line", () => output(${JSON.stringify(parse)}));`);
		const onProtocolError = vi.fn();
		const instance = new RpcClient({
			invocation: { command: process.execPath, args: [entry] },
			onProtocolError,
		});
		clients.push(instance);
		await instance.start();
		const connection = (instance as unknown as { connection: { send: (c: object, t: number) => Promise<unknown> } })
			.connection;
		await expect(connection.send({ type: "get_state" }, 200)).rejects.toThrow(
			"Last protocol error: Failed to parse command: bad line",
		);
		expect(onProtocolError).toHaveBeenCalledWith("Failed to parse command: bad line");
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
		// start() returns at rpc_ready; the frames after it may still be on their way.
		await vi.waitFor(() => expect(event).toHaveBeenCalled(), { timeout: 10_000 });
		expect(identity).toHaveBeenCalledExactlyOnceWith("canonical-id");
		expect(event).toHaveBeenCalledExactlyOnceWith({
			type: "extension_error",
			extensionPath: "command:test",
			event: "command",
			error: "refused",
		});
	});

	it("resolves start() only once the session announces itself, however late", async () => {
		const ready = vi.fn();
		const entry = join(mkdtempSync(join(tmpdir(), "octocode-rpc-late-")), "child.mjs");
		roots.push(dirname(entry));
		writeFileSync(
			entry,
			`setTimeout(() => process.stdout.write(JSON.stringify({type:"rpc_ready",protocolVersion:1,version:"late",sessionId:"s"}) + "\\n"), 400);
process.stdin.resume();`,
		);
		const instance = new RpcClient({ invocation: { command: process.execPath, args: [entry] }, onReady: ready });
		clients.push(instance);
		await instance.start();
		expect(ready).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ version: "late" }));
	});

	it("rejects start() when the process exits before announcing itself", async () => {
		const entry = join(mkdtempSync(join(tmpdir(), "octocode-rpc-early-exit-")), "child.mjs");
		roots.push(dirname(entry));
		writeFileSync(entry, `setTimeout(() => process.exit(3), 300);`);
		const instance = new RpcClient({ invocation: { command: process.execPath, args: [entry] } });
		clients.push(instance);
		await expect(instance.start()).rejects.toThrow("code=3");
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
