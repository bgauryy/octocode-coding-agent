import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultEnvironment, McpClient, StdioTransport } from "../../src/client/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
const stubborn = fileURLToPath(new URL("./fixtures/stubborn-server.mjs", import.meta.url));

/** A server that answers `initialize`, then answers `tools/call` with a result far above the transport's limit. */
function oversizedServer(idFirst: boolean, split: boolean): string {
	return `
		let buffered = "";
		process.stdin.on("data", (chunk) => {
			buffered += chunk;
			const lines = buffered.split("\\n");
			buffered = lines.pop();
			for (const line of lines) answer(line);
		});
		function answer(line) {
			const m = JSON.parse(line);
			if (m.id === undefined) return;
			if (m.method === "initialize") {
				const result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "big", version: "1" } };
				return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
			}
			const result = { content: [{ type: "text", text: "x".repeat(8000) }] };
			const text = JSON.stringify(${idFirst} ? { jsonrpc: "2.0", id: m.id, result } : { jsonrpc: "2.0", result, id: m.id }) + "\\n";
			if (!${split}) return process.stdout.write(text);
			process.stdout.write(text.slice(0, 5000));
			setTimeout(() => process.stdout.write(text.slice(5000)), 30);
		}`;
}

describe("StdioTransport", () => {
	describe("environment", () => {
		const childEnv = async (options: { env?: Record<string, string>; inheritEnv?: boolean }) => {
			const transport = new StdioTransport({
				command: process.execPath,
				args: ["-e", "process.stderr.write(JSON.stringify(process.env))"],
				...options,
			});
			const closed = new Promise<void>((resolve) => transport.onClose(resolve));
			await transport.start();
			await closed;
			return JSON.parse(transport.stderr) as Record<string, string>;
		};
		beforeEach(() => {
			process.env.MCP_TEST_SECRET = "s3cret";
		});
		afterEach(() => {
			delete process.env.MCP_TEST_SECRET;
		});

		it("keeps host secrets out by default and adds the explicit env", async () => {
			const env = await childEnv({ env: { EXPLICIT: "yes" } });
			expect(env.EXPLICIT).toBe("yes");
			expect(env).not.toHaveProperty("MCP_TEST_SECRET");
			expect(env.PATH).toBe(process.env.PATH);
		});

		it("treats inheritEnv false like the default", async () => {
			expect(await childEnv({ inheritEnv: false })).not.toHaveProperty("MCP_TEST_SECRET");
		});

		it("inherits the whole host environment when asked, with the explicit env on top", async () => {
			const env = await childEnv({ inheritEnv: true, env: { MCP_TEST_SECRET: "override" } });
			expect(env.MCP_TEST_SECRET).toBe("override");
			expect(env.PATH).toBe(process.env.PATH);
			expect(Object.keys(env).length).toBeGreaterThan(Object.keys(getDefaultEnvironment()).length);
		});
	});

	describe("oversized responses", () => {
		it.each([
			["leading id", true, false],
			["trailing id", false, false],
			["leading id across writes", true, true],
			["trailing id across writes", false, true],
		])("fail their request at once (%s)", async (_name, idFirst, split) => {
			const transport = new StdioTransport({
				command: process.execPath,
				args: ["-e", oversizedServer(idFirst, split)],
				maxMessageBytes: 2000,
				closeTimeoutMs: 100,
			});
			transport.onError(() => {});
			const client = new McpClient({ name: "stdio-test", version: "1.0.0", requestTimeoutMs: 30_000 });
			await client.connect(transport);
			const started = Date.now();
			await expect(client.callTool("big", {})).rejects.toThrow("exceeds 2000 bytes");
			expect(Date.now() - started).toBeLessThan(5_000);
			await client.close();
		});
	});

	it("drops an oversized message to its end and keeps reading the next one", async () => {
		// The oversized line arrives in two writes, so the transport overflows before it sees the newline.
		const script = `
			const big = '{"jsonrpc":"2.0","method":"big","params":{"x":"' + "a".repeat(200);
			process.stdout.write(big);
			setTimeout(() => process.stdout.write('"}}\\n{"jsonrpc":"2.0","method":"next"}\\n'), 50);
			setTimeout(() => {}, 5000);`;
		const transport = new StdioTransport({
			command: process.execPath,
			args: ["-e", script],
			maxMessageBytes: 100,
			closeTimeoutMs: 100,
		});
		const errors: string[] = [];
		const methods: string[] = [];
		transport.onError((error) => errors.push(error.message));
		transport.onMessage((message) => methods.push((message as { method: string }).method));
		await transport.start();
		for (let i = 0; i < 200 && methods.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		await transport.close();
		expect(methods).toEqual(["next"]);
		expect(errors).toEqual(["MCP stdio message exceeds 100 bytes"]);
	});

	it("connects to a newline-delimited MCP server and captures stderr", async () => {
		const stderr: string[] = [];
		const transport = new StdioTransport({
			command: process.execPath,
			args: [fixture],
			onStderr: (chunk) => stderr.push(chunk),
		});
		const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
		await client.connect(transport);
		expect(await client.listTools()).toEqual([{ name: "echo", inputSchema: { type: "object" } }]);
		expect(await client.callTool("echo", { text: "hello" })).toEqual({
			content: [{ type: "text", text: "hello" }],
		});
		expect(transport.pid).toBeTypeOf("number");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(stderr.join("")).toContain("stdio fixture ready");
		expect(transport.stderr).toContain("stdio fixture ready");
		await client.close();
		expect(client.connectionState).toBe("closed");
	});

	it.skipIf(process.platform === "win32")(
		"stops the real server when its launcher already exited but the server still holds the pipes",
		async () => {
			// Like `npx`: the launcher exits, the server it started keeps running and keeps stdout open.
			const transport = new StdioTransport({
				command: "/bin/sh",
				args: ["-c", "trap '' HUP; sleep 60 & echo server $! >&2; exit 0"],
				closeTimeoutMs: 100,
			});
			await transport.start();
			let server: number | undefined;
			for (let i = 0; i < 200 && server === undefined; i++) {
				const match = /server (\d+)/.exec(transport.stderr);
				if (match) server = Number(match[1]);
				else await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(server).toBeTypeOf("number");
			// Give the launcher time to exit while the server keeps the pipes.
			await new Promise((resolve) => setTimeout(resolve, 100));
			await transport.close();
			const alive = () => {
				try {
					process.kill(server!, 0);
					return true;
				} catch {
					return false;
				}
			};
			for (let i = 0; i < 100 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
			expect(alive()).toBe(false);
		},
	);

	it.skipIf(process.platform === "win32")(
		"kills a server that ignores shutdown, including its children",
		async () => {
			const transport = new StdioTransport({
				command: process.execPath,
				args: [stubborn],
				closeTimeoutMs: 100,
			});
			const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
			await client.connect(transport);
			let grandchild: number | undefined;
			for (let i = 0; i < 100 && grandchild === undefined; i++) {
				const match = /grandchild (\d+)/.exec(transport.stderr);
				if (match) grandchild = Number(match[1]);
				else await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(grandchild).toBeTypeOf("number");

			const startedAt = Date.now();
			await client.close();
			expect(Date.now() - startedAt).toBeLessThan(5_000);
			let alive = true;
			for (let i = 0; i < 100 && alive; i++) {
				try {
					process.kill(grandchild as number, 0);
					await new Promise((resolve) => setTimeout(resolve, 20));
				} catch {
					alive = false;
				}
			}
			expect(alive).toBe(false);
		},
		10_000,
	);
});
