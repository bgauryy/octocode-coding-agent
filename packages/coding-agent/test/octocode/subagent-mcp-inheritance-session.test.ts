import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type JsonObject } from "@octocodeai/octocode-ai";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createMcpExtension } from "../../../mcp/src/index.ts";
import { createTestSession } from "../helpers/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { tmp, trustFolder } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

const echoServer = path.resolve(import.meta.dirname, "fixtures/echo-mcp.mjs");

/** A parent session, a fixture provider serving the child, and a parent model that scripts the tool calls. */
async function fixture(registered = false, configured = false) {
	const root = tmp("child-mcp-inheritance-");
	const cwd = path.join(root, "project");
	const home = path.join(root, "home");
	const agentDir = path.join(root, "agent");
	for (const dir of [cwd, home, agentDir]) fs.mkdirSync(dir);
	// A server from `mcp.json`, which every session (a child's too) loads for itself.
	if (configured)
		fs.writeFileSync(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { cfgecho: { command: process.execPath, args: [echoServer] } } }),
		);
	const requests: JsonObject[] = [];
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(
			`data: ${JSON.stringify({ id: "child", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "CHILD_COMPLETE" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"fixture-local": {
					baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
					apiKey: "fixture-key",
					api: "openai-completions",
					models: [
						{
							id: "fixture",
							name: "Fixture",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 4096,
						},
					],
				},
			},
		}),
	);
	for (const [key, value] of Object.entries({
		HOME: home,
		OCTOCODE_HOME: path.join(home, ".octocode"),
		OCTOCODE_CODING_AGENT_DIR: agentDir,
		CODEX_HOME: path.join(home, ".codex"),
		OCTOCODE_MCP: "0",
		OCTOCODE_OFFLINE: "1",
		OCTOCODE_MODELS_DEV: "0",
		OCTOCODE_PERMISSION: "full",
		OCTOCODE_SUBAGENT: "0",
		OCTOCODE_EXTRA_SKILLS: "0",
		OCTOCODE_SUBAGENT_LINGER_SECONDS: "0",
	}))
		vi.stubEnv(key, value);
	trustFolder(cwd);
	const faux = createFauxCore({
		provider: "faux-parent",
		models: [{ id: "parent", contextWindow: 200000, maxTokens: 4096 }],
	});
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		disabledFeatures: ["mcp", "llama.cpp"],
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			{ name: "mcp", factory: createMcpExtension() },
			{
				name: "parent-fixture",
				factory: (api) => {
					if (registered) api.registerMcpServer("extension-echo", { command: process.execPath, args: [echoServer] });
					api.registerProvider("faux-parent", {
						name: "Fixture parent",
						api: faux.api,
						baseUrl: "http://127.0.0.1:0",
						apiKey: "test",
						models: faux.models,
						streamSimple: faux.streamSimple,
					} as never);
				},
			},
		],
	});
	await resourceLoader.reload();
	const { session } = await createTestSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.create(cwd, path.join(root, "parent-sessions")),
	});
	const confirmations: string[] = [];
	await session.bindExtensions({
		mode: "json",
		// The user confirms the `mcp` tool's add.
		uiContext: {
			confirm: async (title: string, message: string) => {
				confirmations.push(`${title}: ${message}`);
				return true;
			},
			notify: () => undefined,
		} as never,
		shutdownHandler: () => undefined,
	} as never);
	await session.setModel(session.modelRuntime.getModel("faux-parent", "parent")!);
	// The CLI's tool selection activates `mcp`; this loader composes only the extension.
	session.setActiveToolsByName([...session.getActiveToolNames(), "mcp"]);
	const delegate = (): void => {
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("agent", {
						reason: "Delegate the check",
						type: "task",
						goal: "Use the added server",
						task: "Report the servers you have.",
						model: "fixture-local/fixture",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("PARENT_COMPLETE"),
		]);
	};
	return {
		root,
		session,
		requests,
		confirmations,
		faux,
		delegate,
		close: async () => {
			await session.abort("shutdown");
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

const declaredTools = (request: JsonObject): string[] =>
	(request.tools as Array<{ function?: { name?: string } }>).map((tool) => tool.function?.name ?? "");

it("refuses a server add from the model's mcp tool, so nothing reaches the child or mcp.json", async () => {
	const f = await fixture();
	try {
		f.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("mcp", {
						intent: "add",
						server: "echo",
						config: { command: process.execPath, args: [echoServer] },
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("ADDED"),
		]);
		await f.session.prompt("Add the echo server.");
		// Definitions change through `/mcp` or `octocode mcp`; the model's tool refuses before asking the user.
		const added = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(added?.isError, JSON.stringify(added)).toBe(true);
		expect(JSON.stringify(added)).toContain('The mcp intent \\"add\\" was removed');
		expect(f.confirmations).toHaveLength(0);

		f.delegate();
		await f.session.prompt("Delegate.");
		expect(f.requests).toHaveLength(1);
		expect(declaredTools(f.requests[0]).some((name) => name.startsWith("mcp__echo__"))).toBe(false);
		expect(fs.existsSync(path.join(f.root, "project", ".mcp.json"))).toBe(false);
		expect(fs.existsSync(path.join(f.root, "agent", "mcp.json"))).toBe(false);
	} finally {
		await f.close();
	}
}, 60000);

it("gives a child nothing when no server was added", async () => {
	const f = await fixture();
	try {
		f.delegate();
		await f.session.prompt("Delegate.");
		expect(f.requests).toHaveLength(1);
		expect(declaredTools(f.requests[0]).some((name) => name.startsWith("mcp__echo__"))).toBe(false);
	} finally {
		await f.close();
	}
}, 60000);

it("starts a configured server in a child while the parent still runs it", async () => {
	const f = await fixture(false, true);
	try {
		f.delegate();
		await f.session.prompt("Delegate.");
		expect(f.requests).toHaveLength(1);
		expect(declaredTools(f.requests[0])).toContain("mcp__cfgecho__shout");
	} finally {
		await f.close();
	}
}, 60000);

it("leaves out a configured server the parent stopped for this session, and keeps mcp.json unchanged", async () => {
	const f = await fixture(false, true);
	try {
		const config = path.join(f.root, "agent", "mcp.json");
		const before = fs.readFileSync(config, "utf8");
		f.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp", { intent: "stop", server: "cfgecho" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STOPPED"),
		]);
		await f.session.prompt("Stop the configured server.");
		const stopped = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(stopped?.isError, JSON.stringify(stopped)).not.toBe(true);

		f.delegate();
		await f.session.prompt("Delegate.");
		expect(f.requests).toHaveLength(1);
		expect(declaredTools(f.requests[0]).some((name) => name.startsWith("mcp__cfgecho__"))).toBe(false);
		expect(fs.readFileSync(config, "utf8")).toBe(before);
	} finally {
		await f.close();
	}
}, 60000);

it("inherits an extension server even when the child's extension loader does not load its parent plugin", async () => {
	const f = await fixture(true);
	try {
		f.delegate();
		await f.session.prompt("Delegate with the extension server.");
		expect(f.requests).toHaveLength(1);
		// The child's first request carries the server's contract section and declares its tools.
		expect(declaredTools(f.requests[0])).toContain("mcp__extension_echo__shout");
		expect(JSON.stringify(f.requests[0])).toContain(
			'<mcp name=\\"extension-echo\\" tools=\\"mcp__extension_echo__*\\"',
		);
		expect(f.confirmations).toHaveLength(0);
		expect(fs.existsSync(path.join(f.root, "project", ".mcp.json"))).toBe(false);
		expect(fs.existsSync(path.join(f.root, "agent", "mcp.json"))).toBe(false);
		// The handoff file is removed when the run ends.
		const leftovers = fs
			.readdirSync(path.join(f.root, "project"), { recursive: true })
			.filter((entry) => String(entry).includes("mcp-servers-"));
		expect(leftovers).toEqual([]);
	} finally {
		await f.close();
	}
}, 60000);
