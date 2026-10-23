import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpClient, StdioTransport } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
const stubborn = fileURLToPath(new URL("./fixtures/stubborn-server.mjs", import.meta.url));

describe("StdioTransport", () => {
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
