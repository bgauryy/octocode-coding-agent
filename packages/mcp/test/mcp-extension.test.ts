import { octocodePreset } from "../src/presets/octocode/index.ts";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type JsonRpcMessage,
	LegacySseTransport,
	LATEST_PROTOCOL_VERSION,
	McpAuthRequiredError,
	McpHttpError,
	McpSessionExpiredError,
	StreamableHttpTransport,
} from "../src/client/index.ts";
import { createInMemoryTransportPair, type InMemoryTransport } from "../src/client/testing/index.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../coding-agent/src/core/auth-storage.ts";
import { validateMcpServerConfig } from "../src/servers.ts";
import { truncateMiddle } from "../../coding-agent/src/core/tools/truncate.ts";
import { getMcpToolExposure, loadMcpConfig, type McpServerEntry, updateMcpServerConfig } from "../src/config.ts";
import { reachesServer } from "../src/section.ts";
import { McpServerLog } from "../src/log.ts";
import { McpOAuthCredentialStore } from "../src/oauth.ts";
import { createDefaultTransport, McpServerConnection } from "../src/runtime.ts";
import { convertMcpResult, createMcpResultSchema, createMcpToolName } from "../src/tools.ts";

// Config values are resolved at connect time, so the literal reference must survive loading.
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
const TOKEN_HEADER = "Bearer ${TOKEN}";

describe("stdio launch configuration", () => {
	afterEach(() => vi.unstubAllEnvs());
	it("validates environment inheritance and migrates both legacy exposure spellings", () => {
		expect(validateMcpServerConfig("python", { command: "python3", args: ["server.py"], inheritEnv: "no" })).toContain(
			"inheritEnv must be a boolean",
		);
		for (const exposure of ["codemode", "codemode-deferred"]) {
			expect(
				validateMcpServerConfig("python", {
					command: "python3",
					args: ["server.py"],
					exposure,
					toolExposure: { read: exposure },
				}),
			).toMatchObject({
				command: "python3",
				args: ["server.py"],
				exposure: "deferred",
				toolExposure: { read: "deferred" },
			});
		}
	});
	it("launches a binary with only its configured environment when inheritance is disabled", async () => {
		vi.stubEnv("OCTOCODE_TEST_PARENT_SECRET", "must-not-leak");
		const script = `console.log(JSON.stringify({jsonrpc:"2.0",method:"test/environment",params:{inherited:process.env.OCTOCODE_TEST_PARENT_SECRET??null,explicit:process.env.EXPLICIT_VALUE}}));setInterval(()=>{},1000);`;
		const transport = createDefaultTransport(
			{
				name: "binary",
				source: "test",
				config: {
					command: process.execPath,
					args: ["-e", script],
					inheritEnv: false,
					env: { EXPLICIT_VALUE: "present" },
				},
			},
			process.cwd(),
			undefined,
		);
		const message = new Promise<JsonRpcMessage>((resolve) => transport.onMessage(resolve));
		try {
			await transport.start();
			await expect(message).resolves.toMatchObject({ params: { inherited: null, explicit: "present" } });
		} finally {
			await transport.close();
		}
	});
});

describe("MCP config", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function setup(global: unknown, project: unknown) {
		const root = mkdtempSync(join(tmpdir(), "pi-mcp-config-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".octocode"), { recursive: true });
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(global));
		writeFileSync(join(cwd, ".octocode", "mcp.json"), JSON.stringify(project));
		return { agentDir, cwd };
	}

	it("validates SSE and literal headers, preserving literal values at transport creation", () => {
		expect(validateMcpServerConfig("legacy", { type: "sse", url: "https://user@example.com/events" })).toContain(
			"SSE url must not contain credentials",
		);
		expect(
			validateMcpServerConfig("legacy", { type: "sse", url: "https://example.com/events", literalHeaders: "yes" }),
		).toContain("literalHeaders must be a boolean");
		const config = validateMcpServerConfig("legacy", {
			type: "sse",
			url: "https://example.com/events",
			literalHeaders: true,
			headers: { Authorization: TOKEN_HEADER, "X-Command": "!false" },
		});
		expect(typeof config).toBe("object");
		if (typeof config === "string") return;
		const legacy = createDefaultTransport({ name: "legacy", source: "test", config }, process.cwd(), undefined);
		expect(legacy).toBeInstanceOf(LegacySseTransport);
		expect((legacy as LegacySseTransport).options.headers).toEqual({
			Authorization: TOKEN_HEADER,
			"X-Command": "!false",
		});
		const standard = createDefaultTransport(
			{
				name: "remote",
				source: "test",
				config: { url: "https://example.com/mcp", literalHeaders: true, headers: { Authorization: TOKEN_HEADER } },
			},
			process.cwd(),
			undefined,
		);
		expect(standard).toBeInstanceOf(StreamableHttpTransport);
		expect((standard as StreamableHttpTransport).options.headers).toEqual({ Authorization: TOKEN_HEADER });
	});

	it("persists explicit script exposure and Octocode's deferred override across reload", () => {
		const paths = setup({ mcpServers: { docs: { command: "x" }, octocode: { command: "x" } } }, {});
		const file = join(paths.agentDir, "mcp.json");
		updateMcpServerConfig(file, "docs", { exposure: "deferred" });
		updateMcpServerConfig(file, "octocode", { exposure: "deferred" });
		let loaded = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(getMcpToolExposure(loaded.servers.find((s) => s.name === "docs")!.config, "search")).toBe("deferred");
		expect(
			getMcpToolExposure(
				loaded.servers.find((s) => s.name === "octocode")!.config,
				"localFetch",
				octocodePreset(() => [], {}).toolExposure,
			),
		).toBe("deferred");
		updateMcpServerConfig(file, "docs", { exposure: "deferred" });
		loaded = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(getMcpToolExposure(loaded.servers.find((s) => s.name === "docs")!.config, "search")).toBe("deferred");
	});

	it("merges global and trusted project servers and validates entries", () => {
		const paths = setup(
			{
				mcpServers: {
					shared: { command: "global-cmd" },
					remote: { url: "https://example.com/mcp", headers: { Authorization: TOKEN_HEADER } },
					off: { command: "x", enabled: false },
					bad: { args: ["no command"] },
					legacy: { type: "sse", url: "https://example.com/sse" },
					badUrl: { url: "example.com/mcp" },
					"bad name": { command: "x" },
				},
			},
			{ mcpServers: { shared: { command: "project-cmd", exposure: "direct" } } },
		);

		const trusted = loadMcpConfig({ ...paths, projectTrusted: true });
		// Disabled servers are kept so /mcp can enable them again.
		expect(trusted.servers.map((server) => [server.name, server.scope, server.config])).toEqual([
			["shared", "project", { command: "project-cmd", exposure: "direct" }],
			["remote", "global", { url: "https://example.com/mcp", headers: { Authorization: TOKEN_HEADER } }],
			["off", "global", { command: "x", enabled: false }],
			["legacy", "global", { type: "sse", url: "https://example.com/sse" }],
		]);
		expect(trusted.errors).toHaveLength(3);
		expect(trusted.errors[0]).toContain('server "bad" needs either "command"');
		expect(trusted.errors[1]).toContain('server "badUrl": url must be an http or https URL');
		expect(trusted.errors[2]).toContain('invalid server name "bad name"');

		// Untrusted projects cannot add or override servers, since stdio servers run commands.
		const untrusted = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(untrusted.servers.find((server) => server.name === "shared")?.config).toEqual({ command: "global-cmd" });
	});

	// #10277
	it("lets project entries override enabled and exposure of global servers", () => {
		const paths = setup(
			{ mcpServers: { tools: { command: "x", env: { TOKEN: "secret" } } } },
			// An override cannot change the command, which would run with the global env.
			{ mcpServers: { tools: { enabled: false, args: ["y"] }, missing: { enabled: false } } },
		);
		const project = join(paths.cwd, ".octocode", "mcp.json");
		const { servers, errors } = loadMcpConfig({ ...paths, projectTrusted: true });
		expect(servers.map((server) => [server.name, server.override, server.config])).toEqual([
			["tools", undefined, { command: "x", env: { TOKEN: "secret" } }],
		]);
		expect(errors).toEqual([
			expect.stringContaining('server "tools": an override can only set enabled, exposure, toolExposure'),
			expect.stringContaining('server "missing" needs "command" or "url", or a global server to override'),
		]);

		writeFileSync(project, JSON.stringify({ mcpServers: { tools: { enabled: false } } }));
		const [tools] = loadMcpConfig({ ...paths, projectTrusted: true }).servers;
		expect([tools.override, tools.config]).toEqual([
			project,
			{ command: "x", env: { TOKEN: "secret" }, enabled: false },
		]);

		// Overrides keep `enabled: true`, since it replaces the global value.
		updateMcpServerConfig(project, "tools", { enabled: true });
		expect(JSON.parse(readFileSync(project, "utf8")).mcpServers.tools).toEqual({ enabled: true });
	});

	// Regression: #10239.
	it("rejects server names that differ only in - and _", () => {
		const paths = setup({ mcpServers: { "work-files": { command: "a" }, work_files: { command: "b" } } }, {});
		const { servers, errors } = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(servers.map((server) => server.name)).toEqual(["work-files"]);
		expect(errors).toEqual([expect.stringContaining('server "work_files" conflicts with "work-files"')]);
	});

	it("migrates legacy exposure and ignores the removed activation setting", () => {
		const paths = setup(
			{
				autoEnableCodemode: false,
				mcpServers: {
					later: { command: "x", exposure: "deferred" },
					// Legacy script exposure is migrated to native discovery.
					scripts: { command: "x", exposure: "codemode-deferred", toolExposure: { a: "codemode-deferred" } },
					off: { command: "x", exposure: "hidden" },
					wrong: { command: "x", exposure: "model-only" },
					described: { command: "x", description: "Docs search" },
					badDescription: { command: "x", description: 1 },
				},
			},
			{ autoEnableCodemode: "yes", mcpServers: {} },
		);

		const untrusted = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(untrusted.servers.map((server) => [server.name, server.config.exposure])).toEqual([
			["later", "deferred"],
			["scripts", "deferred"],
			["off", "hidden"],
			["described", undefined],
		]);
		expect(untrusted.servers[1].config.toolExposure).toEqual({ a: "deferred" });
		expect(untrusted.servers[3].config.description).toBe("Docs search");
		expect(untrusted.errors).toEqual([
			expect.stringContaining('server "wrong": exposure must be one of'),
			expect.stringContaining('server "badDescription": description must be a string'),
		]);

		// The removed activation setting in the trusted project file adds no error and no field.
		const trusted = loadMcpConfig({ ...paths, projectTrusted: true });
		expect(trusted.errors).toEqual(untrusted.errors);
		expect(trusted).not.toHaveProperty("autoEnableCodemode");
	});

	it("validates the OAuth callback URL, scope, and client name", () => {
		const paths = setup(
			{
				mcpServers: {
					ok: {
						url: "https://a.example/mcp",
						oauth: { callbackUrl: "http://localhost:8080/callback", scope: "a b" },
					},
					ipv6: { url: "https://a.example/mcp", oauth: { callbackUrl: "http://[::1]/cb", callbackPort: 9000 } },
					same: { url: "https://a.example/mcp", oauth: { callbackUrl: "http://127.0.0.1:2/cb", callbackPort: 2 } },
					remote: { url: "https://a.example/mcp", oauth: { callbackUrl: "https://example.com/callback" } },
					both: { url: "https://a.example/mcp", oauth: { callbackUrl: "http://127.0.0.1:1/cb", callbackPort: 2 } },
					scope: { url: "https://a.example/mcp", oauth: { scope: ["a"] } },
					named: { url: "https://a.example/mcp", oauth: { clientName: "Claude Code" } },
					unnamed: { url: "https://a.example/mcp", oauth: { clientName: " " } },
					metadata: { url: "https://a.example/mcp", oauth: { authServerMetadataUrl: "https://idp.example/m" } },
					plainMetadata: {
						url: "https://a.example/mcp",
						oauth: { authServerMetadataUrl: "http://idp.example/m" },
					},
					// #10302
					cimd: {
						url: "https://a.example/mcp",
						oauth: { clientRegistration: "cimd", callbackUrl: "http://localhost/callback" },
					},
					badRegistration: { url: "https://a.example/mcp", oauth: { clientRegistration: "auto" } },
					cimdClient: { url: "https://a.example/mcp", oauth: { clientRegistration: "cimd", clientId: "x" } },
					cimdPath: {
						url: "https://a.example/mcp",
						oauth: { clientRegistration: "cimd", callbackUrl: "http://127.0.0.1/cb" },
					},
				},
			},
			{},
		);
		const { servers, errors } = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(servers.map((server) => server.name)).toEqual(["ok", "ipv6", "same", "named", "metadata", "cimd"]);
		expect(errors).toEqual([
			expect.stringContaining('server "remote": oauth.callbackUrl must be an http URI on localhost'),
			expect.stringContaining('server "both": oauth.callbackUrl and oauth.callbackPort name different ports'),
			expect.stringContaining('server "scope": oauth.scope must be a string'),
			expect.stringContaining('server "unnamed": oauth.clientName must be a non-empty string'),
			expect.stringContaining('server "plainMetadata": oauth.authServerMetadataUrl must be an https URL'),
			expect.stringContaining('server "badRegistration": oauth.clientRegistration must be "dcr" or "cimd"'),
			expect.stringContaining('server "cimdClient": oauth.clientRegistration "cimd" cannot be combined'),
			expect.stringContaining('server "cimdPath": oauth.clientRegistration "cimd" requires oauth.callbackUrl'),
		]);
	});

	it("resolves per-tool exposure from exact names, then patterns in order", () => {
		const paths = setup(
			{
				mcpServers: {
					gh: {
						command: "x",
						exposure: "deferred",
						toolExposure: { "get_*": "deferred", get_me: "direct", "*delete*": "hidden", "get_file.*": "direct" },
					},
					bad: { command: "x", toolExposure: { a: "visible" } },
				},
			},
			{},
		);
		const { servers, errors } = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(errors).toEqual([expect.stringContaining('server "bad": toolExposure "a" must be one of')]);
		const config = servers[0].config;
		expect(getMcpToolExposure(config, "get_me")).toBe("direct");
		expect(getMcpToolExposure(config, "get_issue")).toBe("deferred");
		expect(getMcpToolExposure(config, "get_delete_hint")).toBe("deferred");
		expect(getMcpToolExposure(config, "delete_repo")).toBe("hidden");
		expect(getMcpToolExposure(config, "list_issues")).toBe("deferred");
		// Only `*` is special.
		expect(getMcpToolExposure({ command: "x", toolExposure: { "get_file.*": "hidden" } }, "get_file_x")).toBe("direct");
	});

	it("validates provider auth and accepts it only in the global mcp.json", () => {
		const paths = setup(
			{
				mcpServers: {
					gateway: { url: "https://gateway.example/mcp", auth: { provider: "gateway" } },
					local: { url: "http://localhost:8788/mcp", auth: { provider: "gateway-dev" } },
					plain: { url: "http://gateway.example/mcp", auth: { provider: "gateway" } },
					empty: { url: "https://gateway.example/mcp", auth: { provider: "" } },
				},
			},
			{ mcpServers: { gateway: { url: "https://evil.example/mcp", auth: { provider: "gateway" } } } },
		);
		const { servers, errors } = loadMcpConfig({ ...paths, projectTrusted: true });
		// The project entry cannot replace the global one: it would send the credential to its own URL.
		expect(servers.map((server) => [server.name, server.scope, "url" in server.config && server.config.url])).toEqual([
			["gateway", "global", "https://gateway.example/mcp"],
			["local", "global", "http://localhost:8788/mcp"],
		]);
		expect(errors).toEqual([
			expect.stringContaining('server "plain": auth requires an https URL'),
			expect.stringContaining('server "empty": auth.provider must be a provider name'),
			expect.stringContaining('server "gateway": auth is only allowed in the global mcp.json'),
		]);
	});
});

describe("MCP tools", () => {
	it("creates provider-safe tool names", () => {
		expect(createMcpToolName("docs", "search")).toBe("mcp__docs__search");
		expect(createMcpToolName("my-server", "get.item/v2")).toBe("mcp__my_server__get_item_v2");
		const long = createMcpToolName("server", "x".repeat(100));
		expect(long).toHaveLength(64);
		expect(long).toMatch(/^mcp__server__x+_[0-9a-f]{8}$/);
		expect(createMcpToolName("server", `${"x".repeat(100)}y`)).not.toBe(long);
		// Names that sanitize to one already taken by another tool get a hash suffix.
		const taken = createMcpToolName("s", "a_b");
		const second = createMcpToolName("s", "a-b", (name) => name === taken);
		expect(second).toMatch(/^mcp__s__a_b_[0-9a-f]{8}$/);
	});

	it("declares the structured MCP result, keeping references in the server's output schema", () => {
		expect(createMcpResultSchema(undefined)).toMatchObject({ type: "object", required: ["content"] });

		const hit = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
		const schema = createMcpResultSchema({
			type: "object",
			properties: {
				hits: { type: "array", items: { $ref: "#/$defs/Hit~1v1" } },
				again: { $ref: "#/properties/hits" },
				children: { type: "array", items: { $ref: "#" } },
				// A property named like a keyword whose value is data.
				default: { $ref: "#/definitions/Hit" },
				remote: { $ref: "https://example.com/schema.json" },
			},
			required: ["hits"],
			$defs: { "Hit/v1": { ...hit, default: { $ref: "#/stays" } } },
			definitions: { Hit: hit },
		}) as unknown as { properties: { structuredContent: { $defs: Record<string, { default: unknown }> } } };
		expect(schema).toMatchObject({
			properties: {
				structuredContent: {
					properties: {
						hits: { items: { $ref: "#/properties/structuredContent/$defs/Hit~1v1" } },
						again: { $ref: "#/properties/structuredContent/properties/hits" },
						children: { items: { $ref: "#/properties/structuredContent" } },
						default: { $ref: "#/properties/structuredContent/definitions/Hit" },
						remote: { $ref: "https://example.com/schema.json" },
					},
				},
			},
		});
		// Data that looks like a reference is kept as is.
		expect(schema.properties.structuredContent.$defs["Hit/v1"].default).toEqual({ $ref: "#/stays" });
	});

	it("converts results, passing the CallToolResult to scripts and flagging errors", async () => {
		const blocks = [
			{ type: "text" as const, text: "a text" },
			{ type: "image" as const, data: "aW1n", mimeType: "image/png" },
			{ type: "audio" as const, data: "", mimeType: "audio/wav" },
		];
		expect(
			await convertMcpResult("docs", "t", {
				content: blocks,
				structuredContent: { ok: true },
				_meta: { trace: "x" },
			}),
		).toEqual({
			content: [
				{ type: "text", text: "a text" },
				{ type: "image", data: "aW1n", mimeType: "image/png" },
				{ type: "text", text: "[audio audio/wav omitted]" },
			],
			details: { server: "docs", tool: "t" },
			// Scripts get the server's blocks as sent, without `_meta`.
			structuredContent: { content: blocks, structuredContent: { ok: true } },
		});
		expect((await convertMcpResult("docs", "t", { content: [], structuredContent: { n: 1 } })).content).toEqual([
			{ type: "text", text: '{\n  "n": 1\n}' },
		]);
		// #10416: array structured content reaches the model as JSON and scripts as sent.
		expect(await convertMcpResult("docs", "t", { content: [], structuredContent: [{ id: 1 }] })).toEqual({
			content: [{ type: "text", text: '[\n  {\n    "id": 1\n  }\n]' }],
			details: { server: "docs", tool: "t" },
			structuredContent: { content: [], structuredContent: [{ id: 1 }] },
		});
		expect(await convertMcpResult("docs", "t", { content: [{ type: "text", text: "nope" }], isError: true })).toEqual({
			content: [{ type: "text", text: "nope" }],
			details: { server: "docs", tool: "t" },
			structuredContent: { content: [{ type: "text", text: "nope" }], isError: true },
			isError: true,
		});
		expect((await convertMcpResult("docs", "t", { content: [], isError: true })).content).toEqual([
			{ type: "text", text: "MCP tool docs/t returned an error" },
		]);
	});

	it("saves model-facing text over 20KB whole, shows its start and end, and keeps the full result for scripts", async () => {
		const saved: (string | Uint8Array)[] = [];
		const saveOutput = (data: string | Uint8Array) => {
			saved.push(data);
			return "/tmp/full.txt";
		};
		const lines = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`);
		const full = lines.join("\n");
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const result = { content: [{ type: "text" as const, text: full }, image] };
		const converted = await convertMcpResult("docs", "snapshot", result, { saveOutput });
		expect(converted.content).toHaveLength(2);
		const text = (converted.content[0] as { text: string }).text;
		// The shared spill format: the start, an omission note, the end, then the file with the full text.
		expect(text).toMatch(/^line 1\nline 2\n/);
		expect(text).toMatch(/\[… \d+ lines omitted …\]/);
		expect(text).toMatch(
			/line 3000\n\n\[Output trimmed: showing .* of 3000 lines.*Full output: \/tmp\/full\.txt; search it or read it by line range\.\]$/,
		);
		expect(Buffer.byteLength(text)).toBeLessThan(21 * 1024);
		expect(converted.content[1]).toEqual(image);
		expect(converted.details).toEqual({ server: "docs", tool: "snapshot", fullOutputPath: "/tmp/full.txt" });
		expect(saved).toEqual([full]);
		expect(converted.structuredContent).toEqual(result);

		// Text within the limit is not saved.
		await convertMcpResult("docs", "small", { content: [{ type: "text", text: "ok" }] }, { saveOutput });
		expect(saved).toHaveLength(1);
	});

	it("cuts multi-byte text only at character boundaries", () => {
		const text = `${"é".repeat(20_000)}end`;
		const result = truncateMiddle(text, 1001);
		expect(result.truncated).toBe(true);
		expect(result.content).not.toContain("\uFFFD");
		expect(result.content.endsWith("end")).toBe(true);
		const [head, tail] = result.content.split(/…\d+ chars truncated…/);
		expect(Buffer.byteLength(head)).toBeLessThanOrEqual(500);
		expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(501);
		expect(Array.from(head).length + Array.from(tail).length + result.removedChars).toBe(Array.from(text).length);
	});
});

describe("MCP connections", () => {
	const servers: InMemoryTransport[] = [];

	/** In-memory server that answers initialize, tools/list, and tools/call with "ok". */
	function createTransport(
		options: {
			expireFirstCall?: boolean;
			methods?: string[];
			noTools?: boolean;
			resources?: boolean;
			holdTool?: () => Promise<void>;
		} = {},
	) {
		const pair = createInMemoryTransportPair();
		servers.push(pair.server);
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			options.methods?.push(message.method);
			const response: JsonRpcMessage =
				message.method === "initialize"
					? {
							jsonrpc: "2.0",
							id: message.id,
							result: {
								protocolVersion: LATEST_PROTOCOL_VERSION,
								capabilities: {
									...(options.noTools ? { prompts: {} } : { tools: {} }),
									...(options.resources ? { resources: {} } : {}),
								},
								serverInfo: { name: "fake", version: "1.0.0" },
							},
						}
					: message.method === "tools/list"
						? options.noTools
							? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
							: { jsonrpc: "2.0", id: message.id, result: { tools: [] } }
						: { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } };
			queueMicrotask(async () => {
				if (message.method === "tools/call" && (message.params as { name: string }).name === "hold")
					await options.holdTool?.();
				await pair.server.send(response);
			});
		});
		void pair.server.start();
		if (options.expireFirstCall) {
			const send = pair.client.send.bind(pair.client);
			// Simulates the HTTP transport's 404 for a session the server no longer knows.
			pair.client.send = async (message: JsonRpcMessage) => {
				if (
					"method" in message &&
					message.method === "tools/call" &&
					(message.params as { name: string }).name !== "hold"
				)
					throw new McpSessionExpiredError("gone");
				return send(message);
			};
		}
		return pair.client;
	}

	function connect(
		entry: McpServerEntry,
		transports: (() => ReturnType<typeof createTransport>)[],
		log?: McpServerLog,
	) {
		let opened = 0;
		const connection = new McpServerConnection({
			entry,
			cwd: process.cwd(),
			createTransport: () => transports[opened++](),
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			log,
			onTools: () => {},
		});
		return { connection, opened: () => opened };
	}

	it("stops waiting for a connection when the call is cancelled", async () => {
		// A transport that never finishes connecting, like a server stuck on start.
		const hanging = () =>
			({
				start: () => new Promise<void>(() => {}),
				send: async () => {},
				close: async () => {},
				onMessage: () => () => {},
				onClose: () => () => {},
				onError: () => () => {},
			}) as never;
		const { connection } = connect({ name: "stuck", config: { command: "unused" }, source: "test" }, [hanging]);
		const controller = new AbortController();
		const call = connection.callTool("anything", {}, { signal: controller.signal });
		setTimeout(() => controller.abort(), 20);
		const started = Date.now();
		await expect(call).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("does not respawn a stdio server that keeps failing to start on every call", async () => {
		const failing = () => {
			const transport = createTransport();
			transport.start = async () => {
				throw new Error("exec failed");
			};
			return transport;
		};
		const { connection, opened } = connect({ name: "dies", config: { command: "unused" }, source: "test" }, [
			failing,
			failing,
			failing,
			() => createTransport(),
		]);
		// The first two failures retry at once.
		for (let call = 0; call < 2; call++)
			await expect(connection.callTool("echo", {}, {})).rejects.toThrow("exec failed");
		expect(opened()).toBe(2);
		// Later calls get a clear error without a new process, until the pause ends or the server is restarted.
		await expect(connection.callTool("echo", {}, {})).rejects.toThrow("exec failed");
		expect(opened()).toBe(3);
		await expect(connection.callTool("echo", {}, {})).rejects.toThrow(/failed to connect 3 times in a row.*Restart it/);
		expect(opened()).toBe(3);
		await connection.reconnect();
		expect(opened()).toBe(4);
		await expect(connection.callTool("echo", {}, {})).resolves.toMatchObject({ content: [{ text: "ok" }] });
		await connection.close();
	});

	it("stops a transport whose start is hung and can reconnect afterwards", async () => {
		const close = vi.fn(async () => {});
		const hanging = () =>
			({
				start: () => new Promise<void>(() => {}),
				send: async () => {},
				close,
				onMessage: () => () => {},
				onClose: () => () => {},
				onError: () => () => {},
			}) as never;
		const { connection } = connect({ name: "stuck", config: { command: "unused" }, source: "test" }, [
			hanging,
			() => createTransport(),
		]);
		const opening = connection.getClient().catch(() => undefined);
		const stop = connection.stop();
		const stopped = await Promise.race([
			stop.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
		]);
		expect(stopped).toBe(true);
		await opening;
		expect(close).toHaveBeenCalled();
		await expect(connection.getClient()).rejects.toThrow("stopped");
		await connection.reconnect();
		await expect(connection.callTool("echo", {}, {})).resolves.toMatchObject({ content: [{ text: "ok" }] });
		await connection.close();
	});

	it("starts a new session and retries once when the session expired", async () => {
		const old = createTransport({ expireFirstCall: true });
		const closeOld = vi.fn();
		old.onClose(closeOld);
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => old,
			() => createTransport(),
		]);
		const results = await Promise.all([connection.callTool("echo", {}, {}), connection.callTool("echo", {}, {})]);
		expect(results).toEqual([{ content: [{ type: "text", text: "ok" }] }, { content: [{ type: "text", text: "ok" }] }]);
		expect(opened()).toBe(2);
		await connection.close();
		expect(closeOld).toHaveBeenCalledOnce();
	});

	it("keeps an expired client alive for its in-flight request, then closes it", async () => {
		let releaseTool!: () => void;
		let toolStarted!: () => void;
		const held = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const started = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const old = createTransport({
			expireFirstCall: true,
			resources: true,
			holdTool: async () => {
				toolStarted();
				await held;
			},
		});
		const closeOld = vi.fn();
		old.onClose(closeOld);
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => old,
			() => createTransport(),
		]);
		try {
			const read = connection.callTool("hold", {}, {});
			await started;
			await expect(connection.callTool("echo", {}, {})).resolves.toMatchObject({ content: [{ text: "ok" }] });
			expect(closeOld).not.toHaveBeenCalled();
			releaseTool();
			await expect(read).resolves.toMatchObject({ content: [{ text: "ok" }] });
			await vi.waitFor(() => expect(closeOld).toHaveBeenCalledOnce());
		} finally {
			releaseTool();
			await connection.close();
		}
	});

	it.each(["stop", "close"] as const)("%s closes an expired client even with an in-flight request", async (action) => {
		let toolStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const old = createTransport({
			expireFirstCall: true,
			resources: true,
			holdTool: async () => {
				toolStarted();
				await new Promise<void>(() => {});
			},
		});
		const closeOld = vi.fn();
		old.onClose(closeOld);
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => old,
			() => createTransport(),
		]);
		const read = connection.callTool("hold", {}, {});
		await started;
		await connection.callTool("echo", {}, {});
		const rejected = expect(read).rejects.toThrow();
		await connection[action]();
		expect(closeOld).toHaveBeenCalledOnce();
		await rejected;
		if (action === "stop") await connection.close();
	});

	it.skipIf(process.platform === "win32")("expands ~ in the command, arguments, and cwd of stdio servers", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-home-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		mkdirSync(join(home, "work"));
		// Answers every tool call with its working directory.
		writeFileSync(
			join(home, "server.mjs"),
			`import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
	const message = JSON.parse(line);
	if (!("id" in message)) continue;
	const result = message.method === "initialize"
		? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cwd", version: "1" } }
		: message.method === "tools/list"
			? { tools: [{ name: "cwd", inputSchema: { type: "object" } }] }
			: { content: [{ type: "text", text: process.cwd() }] };
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}`,
		);
		const connection = new McpServerConnection({
			entry: {
				name: "home",
				config: { command: process.execPath, args: ["~/server.mjs"], cwd: "~/work" },
				source: "test",
			},
			cwd: tmpdir(),
			createTransport: createDefaultTransport,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			onTools: () => {},
		});
		try {
			const result = await connection.callTool("cwd", {}, {});
			expect(realpathSync((result.content[0] as { text: string }).text)).toBe(realpathSync(join(home, "work")));
		} finally {
			await connection.close();
			process.env.HOME = previousHome;
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("connects to servers without the tools capability without listing tools", async () => {
		const methods: string[] = [];
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport({ noTools: true, methods }),
		]);
		await connection.getClient();
		expect(connection.state).toBe("connected");
		expect(connection.tools).toEqual([]);
		expect(methods).toEqual(["initialize"]);
		await connection.close();
	});

	it("marks a dropped connection and reconnects on the next call", async () => {
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport(),
			() => createTransport(),
		]);
		await connection.getClient();
		await servers.at(-1)?.close();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(connection.state).toBe("disconnected");
		expect(connection.error).toBe("Connection closed");
		expect(await connection.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(connection.state).toBe("connected");
		expect(opened()).toBe(2);
		await connection.close();
	});

	it("retries HTTP connections that fail with a transient error", async () => {
		const { connection, opened } = connect(
			{ name: "fake", config: { url: "http://unused.invalid", headers: { Authorization: "x" } }, source: "test" },
			[
				() => {
					const transport = createTransport();
					transport.send = async () => {
						throw new McpHttpError(503, "MCP HTTP request failed with status 503");
					};
					return transport;
				},
				() => createTransport(),
			],
		);
		await connection.getClient();
		expect(connection.state).toBe("connected");
		expect(opened()).toBe(2);
		await connection.close();

		const failing = connect(
			{ name: "fake", config: { url: "http://unused.invalid", headers: { Authorization: "x" } }, source: "test" },
			[
				() => {
					const transport = createTransport();
					transport.send = async () => {
						throw new McpHttpError(400, "MCP HTTP request failed with status 400: bad");
					};
					return transport;
				},
			],
		);
		await expect(failing.connection.getClient()).rejects.toThrow("status 400: bad");
		expect(failing.connection.state).toBe("failed");
		expect(failing.opened()).toBe(1);
	});

	// #10249
	it("closes a connection that is still initializing before close returns", async () => {
		const pair = createInMemoryTransportPair();
		// The server receives initialize but never answers it.
		const initializing = new Promise<void>((resolve) => {
			pair.server.onMessage(() => resolve());
		});
		void pair.server.start();
		let transportClosed = false;
		pair.client.onClose(() => {
			transportClosed = true;
		});
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => pair.client,
		]);
		let failure: unknown;
		void connection.getClient().catch((error) => {
			failure = error;
		});
		await initializing;
		await connection.close();
		expect(transportClosed).toBe(true);
		expect(String(failure)).toContain("failed to connect");
	});

	// #10249
	it("stops waiting to retry a connection when closed", async () => {
		const { connection } = connect(
			{ name: "fake", config: { url: "http://unused.invalid", headers: { Authorization: "x" } }, source: "test" },
			[
				() => {
					const transport = createTransport();
					transport.send = async () => {
						throw new McpHttpError(503, "MCP HTTP request failed with status 503");
					};
					return transport;
				},
			],
		);
		let failure: unknown;
		void connection.getClient().catch((error) => {
			failure = error;
		});
		// The first attempt failed; the retry is 250ms away.
		await new Promise((resolve) => setTimeout(resolve, 10));
		await connection.close();
		expect(String(failure)).toContain("status 503");
	});

	it("does not retry tool calls after a transient HTTP error", async () => {
		const transport = createTransport();
		const send = transport.send.bind(transport);
		const failed = new Set<string>();
		// The first call fails with 502.
		transport.send = async (message) => {
			const method = "method" in message ? message.method : "";
			if (method === "tools/call" && !failed.has(method)) {
				failed.add(method);
				throw new McpHttpError(502, "MCP HTTP request failed with status 502");
			}
			return send(message);
		};
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [() => transport]);
		await expect(connection.callTool("echo", {}, {})).rejects.toThrow("status 502");
		await connection.close();
	});

	it("asks OAuth servers that keep rejecting requests for a new sign-in", async () => {
		const { connection } = connect({ name: "fake", config: { url: "http://unused.invalid" }, source: "test" }, [
			() => {
				const transport = createTransport();
				transport.send = async () => {
					throw new McpAuthRequiredError(new Response(null, { status: 401 }));
				};
				return transport;
			},
		]);
		await expect(connection.getClient()).rejects.toThrow('MCP server "fake" requires sign-in. Run /mcp to sign in.');
		expect(connection.state).toBe("needs-auth");
		await connection.close();
	});

	it("sends the provider token and asks for the provider login when the server rejects it", async () => {
		const authorizations: (string | undefined)[] = [];
		const server = createServer((request, response) => {
			authorizations.push(request.headers.authorization);
			request.resume();
			response.writeHead(401).end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		const connection = new McpServerConnection({
			entry: {
				name: "gateway",
				config: { url: `http://127.0.0.1:${port}/mcp`, auth: { provider: "gateway" } },
				source: "test",
			},
			cwd: process.cwd(),
			createTransport: createDefaultTransport,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			providerToken: async (provider) => (provider === "gateway" ? "tok" : undefined),
			onTools: () => {},
		});
		try {
			expect(connection.oauthUrl).toBeUndefined();
			await expect(connection.getClient()).rejects.toThrow(
				'MCP server "gateway" requires sign-in. Run /providers gateway to sign in.',
			);
			expect(connection.state).toBe("needs-auth");
			expect(authorizations).toEqual(["Bearer tok"]);
		} finally {
			await connection.close();
			await new Promise((resolve) => server.close(resolve));
		}
	});

	it("appends client and transport errors to the log file instead of dropping them", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-log-"));
		try {
			const path = join(dir, "mcp.log");
			const { connection } = connect(
				{ name: "fake", config: { command: "unused" }, source: "test" },
				[() => createTransport()],
				new McpServerLog(path),
			);
			await connection.getClient();
			await servers.at(-1)?.send({ jsonrpc: "2.0", unexpected: true } as never);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(readFileSync(path, "utf8").replace(/^\S+ /gm, "")).toBe(
				"[fake] error client: Received invalid JSON-RPC message\n",
			);
			await connection.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("appends server log messages to the log file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-log-"));
		try {
			const path = join(dir, "mcp.log");
			const { connection } = connect(
				{ name: "fake", config: { command: "unused" }, source: "test" },
				[() => createTransport()],
				new McpServerLog(path),
			);
			await connection.getClient();
			const server = servers.at(-1);
			await server?.send({
				jsonrpc: "2.0",
				method: "notifications/message",
				params: { level: "warning", logger: "db", data: "slow\nquery" },
			});
			await server?.send({
				jsonrpc: "2.0",
				method: "notifications/message",
				params: { level: "error", data: { code: 7 } },
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			const lines = readFileSync(path, "utf8").replace(/^\S+ /gm, "");
			expect(lines).toBe('[fake] warning db: slow\n    query\n[fake] error {"code":7}\n');
			await connection.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves the OAuth client secret lazily", async () => {
		const { connection } = connect(
			{
				name: "fake",
				config: { url: "http://unused.invalid", oauth: { clientSecret: "!exit 1" } },
				source: "test",
			},
			[() => createTransport()],
		);
		expect(await connection.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(() => connection.oauthSettings()).toThrow("oauth.clientSecret");
		await connection.close();
	});

	// Unsupported server capabilities never trigger resource RPCs.
	it("connects to servers with resources without listing them", async () => {
		const methods: string[] = [];
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport({ resources: true, methods }),
		]);
		await connection.getClient();
		expect(connection.state).toBe("connected");
		expect(connection).not.toHaveProperty("hasResources");
		expect(methods).toEqual(["initialize", "tools/list"]);
		await connection.close();
	});
});

describe("tool_search reach", () => {
	it("matches a plugin server whose name keeps '-' in its namespace, however the model spells it", () => {
		const server = "plugin:my-plug:srv";
		for (const word of ["mcp__plugin_my_plug_srv", "mcp__plugin_my-plug_srv", "mcp__plugin_my_plug_srv__find"])
			expect(reachesServer([word], server)).toBe(true);
		expect(reachesServer(["mcp__other"], server)).toBe(false);
		expect(reachesServer(["mcp__docs"], "docs")).toBe(true);
	});
});
