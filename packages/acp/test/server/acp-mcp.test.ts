import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type McpServer } from "@agentclientprotocol/sdk";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { McpClient, StdioTransport, StreamableHttpTransport } from "../../../mcp/src/client/index.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACP_MCP_MANIFEST_ENV, ACP_WORKER_ENV } from "../../../common/src/env.ts";
import { registerAcpClientMcpServers } from "../../../mcp/src/acp-session-servers.ts";
import { registerFeature } from "../../../coding-agent/src/core/features/register.ts";
import { createExtensionRuntime } from "../../../coding-agent/src/core/features/runtime.ts";
import type { ExtensionRuntime } from "../../../coding-agent/src/core/features/types.ts";
import { createDefaultTransport } from "../../../mcp/src/runtime/transport.ts";
import { acpServerHost } from "../../../coding-agent/src/main/acp-host.ts";
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
		const entry = await prepareAcpMcpServers(servers, workspace, acpServerHost);
		prepared.push(entry);
		return entry;
	}
	const manifestOf = (entry: AcpMcpServers): string => entry.env[ACP_MCP_MANIFEST_ENV];
	/** What the worker's MCP host does with the environment the broker gave it, through the feature registration API. */
	async function registerInWorker(
		entry: AcpMcpServers,
		runtime: ExtensionRuntime = createExtensionRuntime(),
		env: NodeJS.ProcessEnv = { ...entry.env, [ACP_WORKER_ENV]: "1" },
	) {
		const extension = await registerFeature(
			{ id: "acp-client-mcp", owner: "builtin", register: (api) => registerAcpClientMcpServers(api, env) },
			createEventBus(),
			runtime,
			workspace,
		);
		return { extension, runtime };
	}

	it("registers through the MCP host's manifest path, carries literal env and arguments through an MCP round trip, and cleans up", async () => {
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
		const directory = dirname(manifestOf(entry));
		if (process.platform !== "win32") {
			expect((await stat(directory)).mode & 0o777).toBe(0o700);
			expect((await stat(join(directory, "manifest.json"))).mode & 0o777).toBe(0o600);
		}
		const loaded = await registerInWorker(entry);
		const registered = loaded.runtime.mcpServers.list();
		expect(registered).toHaveLength(1);
		expect(registered[0].name).toMatch(/^acp_[a-f0-9]{16}$/);
		expect(registered[0].config.description).toContain("client server / ü");
		for (const handler of loaded.extension.handlers.get("session_start") ?? [])
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

	it("keeps the cause when the registration state cannot be read, unlike a missing state file", async () => {
		const entry = await prepare([server()]);
		await expect(entry.verify()).rejects.toThrow("did not initialize");
		await writeFile(join(dirname(manifestOf(entry)), "ready.json"), "{not json");
		const failure = await entry.verify().then(
			() => undefined,
			(error: unknown) => error,
		);
		expect((failure as Error).message).toContain("registration state could not be read");
		expect((failure as Error).message).not.toContain("did not initialize");
		expect((failure as Error).cause).toBeInstanceOf(SyntaxError);
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
		const loaded = await registerInWorker(entry);
		const config = loaded.runtime.mcpServers.list()[0].config;
		expect(config).toMatchObject({
			type: "http",
			url: "https://example.com/mcp",
			headers: { [header]: literal },
			literalHeaders: true,
		});
		const transport = createDefaultTransport(
			{ name: "client", config, source: manifestOf(entry) },
			workspace,
			undefined,
		);
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
		const loaded = await registerInWorker(entry);
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
				} catch {
					// The process already exited.
				}
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

	it("reports registration conflicts rather than silently dropping requested servers", async () => {
		const entry = await prepare([server()]);
		const first = await registerInWorker(entry);
		expect(first.runtime.mcpServers.list()).toHaveLength(1);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const second = await registerInWorker(entry, first.runtime);
			expect(second.runtime.mcpServers.list()).toHaveLength(1);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("already registered"));
		} finally {
			stderr.mockRestore();
		}
		await expect(entry.verify()).rejects.toThrow("already registered");
	});

	it("refuses a manifest of the wrong shape with a clear error and registers nothing", async () => {
		const entry = await prepare([server()]);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			for (const [manifest, message] of [
				["{not json", "JSON"],
				[JSON.stringify({ version: 2, cwd: workspace, runtime: "node", servers: [] }), "not an ACP MCP manifest"],
				[JSON.stringify({ version: 1, cwd: workspace, runtime: "node", servers: [{ name: "a" }] }), "servers[0]"],
			] as const) {
				await writeFile(manifestOf(entry), manifest);
				const registered = await registerInWorker(entry);
				expect(registered.runtime.mcpServers.list()).toEqual([]);
				await expect(entry.verify()).rejects.toThrow(message);
			}
		} finally {
			stderr.mockRestore();
		}
	});

	it("does nothing without the broker's worker marker or manifest variable", async () => {
		const entry = await prepare([server()]);
		for (const env of [{ [ACP_MCP_MANIFEST_ENV]: manifestOf(entry) }, { [ACP_WORKER_ENV]: "1" }]) {
			const registered = await registerInWorker(entry, undefined, env);
			expect(registered.runtime.mcpServers.list()).toEqual([]);
		}
		await expect(entry.verify()).rejects.toThrow("did not initialize");
	});

	it("passes no environment for an empty list", async () => {
		const entry = await prepare([]);
		expect(entry.env).toEqual({});
		await entry.verify();
	});
});
