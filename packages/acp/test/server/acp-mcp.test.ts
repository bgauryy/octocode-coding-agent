import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type McpServer } from "@agentclientprotocol/sdk";
import { McpClient, StdioTransport, StreamableHttpTransport } from "../../../mcp/src/client/index.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadExtensions } from "../../../coding-agent/src/core/extensions/loader.ts";
import { createDefaultTransport } from "../../../mcp/src/runtime/transport.ts";
import { type AcpMcpServers, prepareAcpMcpServers } from "../../src/server/mcp.ts";

describe("ACP session MCP servers", () => {
	let workspace: string;
	let home: string;
	const prepared: AcpMcpServers[] = [];
	beforeEach(async () => {
		workspace = await realpath(await mkdtemp(join(tmpdir(), "acp-mcp-workspace-")));
		home = await mkdtemp(join(tmpdir(), "acp-mcp-home-"));
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", home);
	});
	afterEach(async () => {
		await Promise.all(prepared.splice(0).map((entry) => entry.cleanup()));
		await rm(workspace, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});
	const server = (changes: Partial<Extract<McpServer, { command: string }>> = {}): McpServer => ({
		name: "client server / ü",
		command: process.execPath,
		args: [],
		env: [],
		...changes,
	});
	async function prepare(servers: McpServer[]) {
		const entry = await prepareAcpMcpServers(servers, workspace);
		prepared.push(entry);
		return entry;
	}

	it("loads through the actual extension loader, carries literal env and arguments through an MCP round trip, and cleans up", async () => {
		const fixture = join(workspace, "server.mjs");
		await writeFile(
			fixture,
			`import { createInterface } from "node:readline";
for await (const line of createInterface({input: process.stdin})) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const result = request.method === "initialize"
    ? {protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}
    : {content:[{type:"text",text:JSON.stringify({literal:process.env.LITERAL,argument:process.argv[2],cwd:process.cwd()})}]};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
}`,
		);
		const literal = "!touch should-never-run; ${HOME} `quote`\nsecond line";
		const argument = "$(touch should-not-run) ' \" \\ value";
		const entry = await prepare([server({ args: [fixture, argument], env: [{ name: "LITERAL", value: literal }] })]);
		await expect(entry.verify()).rejects.toThrow("did not initialize");
		const extensionPath = entry.args[1];
		const directory = dirname(extensionPath);
		if (process.platform !== "win32") {
			expect((await stat(directory)).mode & 0o777).toBe(0o700);
			expect((await stat(join(directory, "manifest.json"))).mode & 0o777).toBe(0o600);
		}
		const loaded = await loadExtensions([extensionPath], workspace);
		expect(loaded.errors).toEqual([]);
		const registered = loaded.runtime.mcpServers.list();
		expect(registered).toHaveLength(1);
		expect(registered[0].name).toMatch(/^acp_[a-f0-9]{16}$/);
		expect(registered[0].config.description).toContain("client server / ü");
		for (const handler of loaded.extensions[0].handlers.get("session_start") ?? [])
			await handler({ type: "session_start" }, {});
		await entry.verify();
		const config = registered[0].config;
		if (!("command" in config)) throw new Error("Expected stdio registration");
		const client = new McpClient({ name: "acp-mcp-test", version: "1", requestTimeoutMs: 5000 });
		try {
			await client.connect(new StdioTransport(config));
			const result = await client.callTool("echo", {});
			expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ literal, argument, cwd: workspace }) }]);
		} finally {
			await client.close();
		}
		await expect(readFile(join(home, "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
		await entry.cleanup();
		await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses unsupported transports, duplicate names, non-absolute commands and invalid environment entries", async () => {
		await expect(
			prepare([{ type: "acp", name: "channel", serverId: "fixture" } as unknown as McpServer]),
		).rejects.toThrow("unsupported");
		await expect(prepare([{ type: "http", name: "bad", url: "file:///tmp/mcp", headers: [] }])).rejects.toThrow("URL");
		await expect(
			prepare([{ type: "http", name: "credentials", url: "https://user:pass@example.com/mcp", headers: [] }]),
		).rejects.toThrow("credentials or fragment");
		await expect(
			prepare([{ type: "http", name: "fragment", url: "https://example.com/events#token", headers: [] }]),
		).rejects.toThrow("credentials or fragment");
		await expect(
			prepare([
				{
					type: "http",
					name: "bad",
					url: "https://example.com/mcp",
					headers: [
						{ name: "Authorization", value: "a" },
						{ name: "authorization", value: "b" },
					],
				},
			]),
		).rejects.toThrow("Duplicate MCP HTTP header");
		await expect(prepare([server(), server()])).rejects.toThrow("Duplicate ACP MCP");
		await expect(prepare([server({ command: "node" })])).rejects.toThrow("absolute");
		await expect(prepare([server({ env: [{ name: "BAD=NAME", value: "x" }] })])).rejects.toThrow("invalid");
		await expect(
			prepare([
				server({
					env: [
						{ name: "NAME", value: "a" },
						{ name: "NAME", value: "b" },
					],
				}),
			]),
		).rejects.toThrow("Duplicate MCP environment");
	});

	it.each(["Authorization", "__proto__"])("preserves literal HTTP header %s through registration", async (header) => {
		const literal = "!printf never; ${MISSING_ENV}";
		const entry = await prepare([
			{
				type: "http",
				name: "remote",
				url: "https://example.com/mcp",
				headers: [{ name: header, value: literal }],
			},
		]);
		const loaded = await loadExtensions([entry.args[1]], workspace);
		expect(loaded.errors).toEqual([]);
		const config = loaded.runtime.mcpServers.list()[0].config;
		expect(config).toMatchObject({
			type: "http",
			url: "https://example.com/mcp",
			headers: { [header]: literal },
			literalHeaders: true,
		});
		const transport = createDefaultTransport({ name: "client", config, source: entry.args[1] }, workspace, undefined);
		expect(transport).toBeInstanceOf(StreamableHttpTransport);
		if (!(transport instanceof StreamableHttpTransport)) throw new Error("Expected streamable HTTP transport");
		expect(transport.options.headers?.[header]).toBe(literal);
	});

	it("rejects duplicate special-property header names before writing configuration", async () => {
		await expect(
			prepare([
				{
					type: "http",
					name: "remote",
					url: "https://example.com/mcp",
					headers: [
						{ name: "__proto__", value: "first" },
						{ name: "__PROTO__", value: "second" },
					],
				},
			]),
		).rejects.toThrow("Duplicate MCP HTTP header");
	});

	it("rejects legacy SSE client registrations", async () => {
		await expect(
			prepare([{ type: "sse", name: "events", url: "https://example.com/events", headers: [] }]),
		).rejects.toThrow("Legacy SSE MCP transport is unsupported");
	});

	it("closes a wrapped server that ignores SIGTERM when the MCP transport closes", async () => {
		const entry = await prepare([
			server({
				args: [
					"--input-type=module",
					"-e",
					`import { createInterface } from "node:readline";
process.on("SIGTERM", () => {});
setInterval(() => {}, 10000);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const result = request.method === "initialize"
    ? {protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"stubborn",version:"1"}}
    : {content:[{type:"text",text:String(process.pid)}]};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
}`,
				],
			}),
		]);
		const loaded = await loadExtensions([entry.args[1]], workspace);
		expect(loaded.errors).toEqual([]);
		const config = loaded.runtime.mcpServers.list()[0].config;
		if (!("command" in config)) throw new Error("Expected stdio registration");
		const client = new McpClient({ name: "acp-mcp-close-test", version: "1", requestTimeoutMs: 5000 });
		let pid: number | undefined;
		try {
			await client.connect(new StdioTransport({ ...config, closeTimeoutMs: 1500 }));
			const result = await client.callTool("pid", {});
			const content = result.content[0];
			if (content.type !== "text") throw new Error("Expected server process ID");
			pid = Number(content.text);
			expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
			await client.close();
			expect(() => process.kill(pid!, 0)).toThrow();
		} finally {
			await client.close();
			if (pid !== undefined) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
	});

	it("rejects configured namespace collisions, including untrusted project configuration", async () => {
		const name = "client server / ü";
		const namespace = `acp_${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
		await mkdir(join(workspace, ".octocode"));
		await writeFile(
			join(workspace, ".octocode", "mcp.json"),
			JSON.stringify({ mcpServers: { [namespace]: { command: process.execPath } } }),
		);
		await expect(prepare([server()])).rejects.toThrow("already configured");
	});

	it("reports extension registration conflicts rather than silently dropping requested servers", async () => {
		const entry = await prepare([server()]);
		const loaded = await loadExtensions([entry.args[1]], workspace);
		expect(loaded.errors).toEqual([]);
		const conflicting = await loadExtensions([entry.args[1]], workspace, undefined, loaded.runtime);
		expect(conflicting.errors[0].error).toContain("already registered");
		await expect(entry.verify()).rejects.toThrow("already registered");
	});

	it("does not create an extension for an empty list", async () => {
		const entry = await prepare([]);
		expect(entry.args).toEqual([]);
		await entry.verify();
	});
});
