import { approveFixtureMcp } from "./guard-helpers.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemMessage,
	getCurrentTools,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { liveStdioServerPids } from "../../../mcp/src/client/transports/stdio.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { sectionFamilyText } from "../../src/core/system-prompt-spec.ts";
import { createTestSession } from "../helpers/session.ts";
import { nativeCall } from "./e2e-calls.ts";
import { trustFolder } from "./helpers.ts";

/** A request's sections, with `mcps` holding its head and every `mcps:<server>` block. */
function mcpSections(messages: Parameters<typeof getCurrentSystemMessage>[0]): Record<string, string> {
	const sections = (getCurrentSystemMessage(messages)?.sections ?? {}) as Record<string, string>;
	return { ...sections, mcps: sectionFamilyText(sections, "mcps") };
}

/**
 * An external stdio MCP server the user adds to the trusted workspace's `.octocode/mcp.json`, with no `exposure`
 * setting (the default), on a scripted model: the agent's first request declares and describes its tool, a scripted
 * call returns the server's token, and the next request carries that token to the model.
 */
const SERVER = path.join(import.meta.dirname, "fixtures", "echo-secret-mcp.mjs");
const TOKEN = "EXT-MCP-OK-7731";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * The real teardown: `AgentSessionRuntime.dispose()` emits `session_shutdown` (which closes the session's MCP
 * connections) before disposing the session. `AgentSession.dispose()` alone does not.
 */
async function disposeThroughRuntime(
	agent: Awaited<ReturnType<typeof createTestSession>>["session"],
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	resourceLoader: DefaultResourceLoader,
): Promise<void> {
	const unused: CreateAgentSessionRuntimeFactory = async () => {
		throw new Error("not used");
	};
	const services = {
		cwd,
		agentDir,
		modelRuntime: agent.modelRuntime,
		settingsManager,
		resourceLoader,
		diagnostics: [],
	};
	await new AgentSessionRuntime(agent, services, unused).dispose();
}

it("exposes an external workspace MCP server by default, runs a call and returns the result to the model", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-e2e-extmcp-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(cwd, ".octocode"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	trustFolder(cwd);
	fs.writeFileSync(
		path.join(cwd, ".octocode", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				octocode: { command: "false", enabled: false },
				secretecho: { command: process.execPath, args: [SERVER] },
			},
		}),
	);
	const saved = {
		HOME: process.env.HOME,
		agentDir: process.env.OCTOCODE_CODING_AGENT_DIR,
		permission: process.env.OCTOCODE_PERMISSION,
	};
	process.env.HOME = root;
	process.env.OCTOCODE_CODING_AGENT_DIR = agentDir;
	process.env.OCTOCODE_PERMISSION = "workspace";
	const faux = createFauxCore({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4_096 }],
	});
	const provider: ExtensionFactory = (api) => {
		api.registerProvider("faux", {
			name: "Faux",
			api: faux.api,
			baseUrl: "http://127.0.0.1:0",
			apiKey: "test",
			models: faux.models.map((model) => ({
				...model,
				promptCache: { short: 300, long: 3600 },
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
			streamSimple: faux.streamSimple,
		} as never);
	};
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	// What a session in a folder the user trusted reads: the workspace `mcp.json` loads only then.
	settingsManager.setProjectTrusted(true);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [{ name: "faux-provider", factory: provider }],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	approveFixtureMcp(cwd, agentDir);
	await resourceLoader.reload();
	const { session: agent } = await createTestSession({
		cwd,
		agentDir,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	const dispose = () => disposeThroughRuntime(agent, cwd, agentDir, settingsManager, resourceLoader);
	cleanups.push(async () => {
		await dispose();
		process.env.HOME = saved.HOME;
		if (saved.agentDir === undefined) delete process.env.OCTOCODE_CODING_AGENT_DIR;
		else process.env.OCTOCODE_CODING_AGENT_DIR = saved.agentDir;
		if (saved.permission === undefined) delete process.env.OCTOCODE_PERMISSION;
		else process.env.OCTOCODE_PERMISSION = saved.permission;
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	await agent.bindExtensions({ mode: "json", shutdownHandler: () => undefined } as never);
	await agent.setModel(agent.modelRuntime.getModel("faux", "faux-1")!);

	const requests: TranscriptContext[] = [];
	const step = (response: ReturnType<typeof fauxAssistantMessage>) => (context: TranscriptContext) => {
		requests.push(context);
		return response;
	};
	faux.setResponses([
		step(
			fauxAssistantMessage([fauxToolCall("mcp__secretecho__echo_secret", {})], {
				stopReason: "toolUse",
			}),
		),
		step(fauxAssistantMessage("done")),
	]);
	await agent.prompt("What does the secret echo service return?");
	expect(requests).toHaveLength(2);

	// Exposure: a native function declaration with the server's description, plus its instructions in the cached `mcps` section.
	const first = requests[0];
	const sections = mcpSections(first.messages);
	const declaration = getCurrentTools(first.messages).find((tool) => tool.name === "mcp__secretecho__echo_secret");
	expect(declaration?.description).toContain("Return the secret echo service token.");
	expect(sections.mcps).toContain('<mcp name="secretecho" tools="mcp__secretecho__*">');
	expect(sections.mcps).toContain("Secret echo service. Call echo_secret to read the service token.");
	expect(sections.mcps).not.toContain("Return the secret echo service token.");

	// The call ran and returned the token.
	const result = agent.messages.find((message) => message.role === "toolResult");
	expect(result).toMatchObject({ toolName: "mcp__secretecho__echo_secret", isError: false });
	expect(JSON.stringify(result?.content)).toContain(TOKEN);

	// The next model request carries the tool result.
	const second = JSON.stringify(requests[1].messages.filter((message) => message.role === "toolResult"));
	expect(second).toContain(TOKEN);
});

/**
 * A server with instructions and three tools whose input fields all carry descriptions
 * (`fixtures/multi-tool-mcp.mjs`): what the agent is told about it, in each exposure mode.
 */
const MULTI = path.join(import.meta.dirname, "fixtures", "multi-tool-mcp.mjs");
const INSTRUCTIONS =
	"Inventory service rules: always search before reserving, and never reserve more than the stock reported.";
const TOOLS = {
	search_items: {
		description: "Search the warehouse catalog by free-text query.",
		fields: {
			query: "Free-text catalog query, such as a product name.",
			limit: "Maximum rows to return, between one and fifty.",
		},
	},
	reserve_item: {
		description: "Reserve units of one catalog item for an order.",
		fields: {
			sku: "Stock keeping unit of the item to reserve.",
			priority: "Shipping tier that sets the reservation priority.",
			customer: "Customer that owns the reservation.",
			email: "Contact email address of the customer.",
		},
	},
	release_item: {
		description: "Release a reservation back to the stock.",
		fields: { reservationId: "Identifier of the reservation to release." },
	},
} as const;
const ENUM_VALUES = ["standard", "express", "overnight"];

async function startMultiToolSession(serverConfig: Record<string, unknown>, script = MULTI, name = "inventory") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-e2e-multimcp-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(cwd, ".octocode"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	trustFolder(cwd);
	fs.writeFileSync(
		path.join(cwd, ".octocode", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				octocode: { command: "false", enabled: false },
				[name]: { command: process.execPath, args: [script], ...serverConfig },
			},
		}),
	);
	const saved = {
		HOME: process.env.HOME,
		agentDir: process.env.OCTOCODE_CODING_AGENT_DIR,
		permission: process.env.OCTOCODE_PERMISSION,
	};
	process.env.HOME = root;
	process.env.OCTOCODE_CODING_AGENT_DIR = agentDir;
	process.env.OCTOCODE_PERMISSION = "workspace";
	const faux = createFauxCore({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4_096 }],
	});
	const provider: ExtensionFactory = (api) => {
		api.registerProvider("faux", {
			name: "Faux",
			api: faux.api,
			baseUrl: "http://127.0.0.1:0",
			apiKey: "test",
			models: faux.models.map((model) => ({
				...model,
				promptCache: { short: 300, long: 3600 },
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
			streamSimple: faux.streamSimple,
		} as never);
	};
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	settingsManager.setProjectTrusted(true);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [{ name: "faux-provider", factory: provider }],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	approveFixtureMcp(cwd, agentDir);
	await resourceLoader.reload();
	const { session: agent } = await createTestSession({
		cwd,
		agentDir,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	const dispose = () => disposeThroughRuntime(agent, cwd, agentDir, settingsManager, resourceLoader);
	cleanups.push(async () => {
		await dispose();
		process.env.HOME = saved.HOME;
		if (saved.agentDir === undefined) delete process.env.OCTOCODE_CODING_AGENT_DIR;
		else process.env.OCTOCODE_CODING_AGENT_DIR = saved.agentDir;
		if (saved.permission === undefined) delete process.env.OCTOCODE_PERMISSION;
		else process.env.OCTOCODE_PERMISSION = saved.permission;
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	await agent.bindExtensions({ mode: "json", shutdownHandler: () => undefined } as never);
	await agent.setModel(agent.modelRuntime.getModel("faux", "faux-1")!);
	const requests: TranscriptContext[] = [];
	const step = (response: ReturnType<typeof fauxAssistantMessage>) => (context: TranscriptContext) => {
		requests.push(context);
		return response;
	};
	const toolCall = (name: string, args: Record<string, unknown>) =>
		step(fauxAssistantMessage([nativeCall(name, args)], { stopReason: "toolUse" }));
	const mcpBlock = () => {
		const sections = mcpSections(requests[0].messages);
		const start = sections.mcps.indexOf('<mcp name="inventory"');
		return sections.mcps.slice(start, sections.mcps.indexOf("</mcp>", start) + "</mcp>".length);
	};
	return { agent, faux, requests, step, toolCall, mcpBlock, dispose };
}

it("tells the agent a direct server's instructions and every tool, description and field", async () => {
	const { agent, faux, requests, step, toolCall, mcpBlock } = await startMultiToolSession({ exposure: "direct" });
	faux.setResponses([
		toolCall("mcp__inventory__search_items", { query: "bolt", limit: 5 }),
		toolCall("mcp__inventory__search_items", { query: "bolt", limit: "five" }),
		toolCall("mcp__inventory__reserve_item", { sku: "B-1", priority: "express", customer: { email: "a@b.co" } }),
		step(fauxAssistantMessage("done")),
	]);
	await agent.prompt("Reserve a bolt.");
	expect(requests).toHaveLength(4);

	const block = mcpBlock();
	expect(block).toContain('<mcp name="inventory" tools="mcp__inventory__*">');
	expect(block).toContain(INSTRUCTIONS);
	// Each tool's description, field docs and enum values are in its own declaration, not repeated in the block.
	const declarations = getCurrentTools(requests[0].messages);
	for (const [name, tool] of Object.entries(TOOLS)) {
		const declared = declarations.find((candidate) => candidate.name === `mcp__inventory__${name}`);
		expect(declared, name).toBeDefined();
		expect(declared?.description, name).toContain(tool.description);
		const schema = JSON.stringify(declared?.parameters);
		for (const [field, description] of Object.entries(tool.fields)) {
			expect(schema, `${name}.${field}`).toContain(field);
			expect(schema, `${name}.${field}`).toContain(description);
		}
		expect(block, name).not.toContain(tool.description);
	}
	const schemas = JSON.stringify(declarations.map((tool) => tool.parameters));
	for (const value of ENUM_VALUES) expect(schemas).toContain(value);

	// A valid call succeeds; a wrong-type argument is refused with an error naming the field.
	const results = agent.messages.filter((message) => message.role === "toolResult");
	expect(results).toHaveLength(3);
	expect(results[0]).toMatchObject({ toolName: "mcp__inventory__search_items", isError: false });
	expect(JSON.stringify(results[0]?.content)).toContain("search_items ok");
	expect(results[1]).toMatchObject({ toolName: "mcp__inventory__search_items", isError: true });
	expect(JSON.stringify(results[1]?.content)).toContain("limit");
	expect(results[2]).toMatchObject({ toolName: "mcp__inventory__reserve_item", isError: false });
});

it("defers an unused server by default: each tool's whole description and field names, its schema on use", async () => {
	const { agent, faux, requests, toolCall, step, mcpBlock } = await startMultiToolSession({});
	faux.setResponses([
		toolCall("mcp__inventory__search_items", { query: "bolt", limit: "five" }),
		step(fauxAssistantMessage("done")),
	]);
	await agent.prompt("Find a bolt.");
	expect(mcpBlock()).toContain(INSTRUCTIONS);
	const declarations = getCurrentTools(requests[0].messages);
	for (const [name, tool] of Object.entries(TOOLS)) {
		const declared = declarations.find((candidate) => candidate.name === `mcp__inventory__${name}`);
		// The server's own description, unchanged; the top-level field names without the field docs.
		expect(declared?.description, name).toContain(tool.description);
		const parameters: { properties?: object } | undefined = declared?.parameters;
		expect(Object.keys(parameters?.properties ?? {}), name).not.toEqual([]);
		const schema = JSON.stringify(declared?.parameters);
		for (const [field, description] of Object.entries(tool.fields))
			expect(schema, `${name}.${field}`).not.toContain(description);
	}
	// A call the full schema rejects returns that schema, field docs included.
	const refused = agent.messages.find((message) => message.role === "toolResult");
	expect(refused).toMatchObject({ toolName: "mcp__inventory__search_items", isError: true });
	expect(JSON.stringify(refused?.content)).toContain(TOOLS.search_items.fields.query);
});

it("indexes a deferred server's tools and loads one tool's full description and field docs on demand", async () => {
	const { agent, faux, requests, step, mcpBlock } = await startMultiToolSession({
		exposure: "deferred",
		description: "Reserves warehouse stock.",
	});
	faux.setResponses([
		step(
			fauxAssistantMessage(
				[fauxToolCall("mcp", { intent: "tools", server: "inventory", tool: "reserve_item", reason: "load" })],
				{ stopReason: "toolUse" },
			),
		),
		step(fauxAssistantMessage("done")),
	]);
	await agent.prompt("Reserve a bolt.");
	expect(requests).toHaveLength(2);

	const block = mcpBlock();
	expect(block).toContain(INSTRUCTIONS);
	// A deferred tool is listed by name; its declaration carries the server's whole description, unchanged.
	const declared = getCurrentTools(requests[0].messages);
	for (const [name, tool] of Object.entries(TOOLS)) {
		expect(block).toContain(`\n- ${name}\n`);
		expect(declared.find((one) => one.name === `mcp__inventory__${name}`)?.description).toBe(tool.description);
	}
	expect(block).not.toContain("declare namespace");

	const result = agent.messages.find((message) => message.role === "toolResult");
	expect(result).toMatchObject({ toolName: "mcp", isError: false });
	const text = JSON.stringify(result?.content);
	expect(text).toContain(TOOLS.reserve_item.description);
	for (const description of Object.values(TOOLS.reserve_item.fields)) expect(text).toContain(description);
	for (const value of ENUM_VALUES) expect(text).toContain(value);
});

/** Child processes of this test process whose command line runs `script`. */
function childrenRunning(script: string): number[] {
	return execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
		.split("\n")
		.flatMap((line) => {
			const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
			return match && Number(match[2]) === process.pid && match[3].includes(script) ? [Number(match[1])] : [];
		});
}

it("reports a server whose process was killed mid-session as down, and calls work again after a restart", async () => {
	// Servers other tests in this file left running are not this session's.
	const others = new Set(childrenRunning(path.basename(SERVER)));
	const { agent, faux, step } = await startMultiToolSession({}, SERVER, "secretecho");
	const mine = () => childrenRunning(path.basename(SERVER)).filter((pid) => !others.has(pid));
	const echo = () => fauxToolCall("mcp__secretecho__echo_secret", {});
	const list = () => fauxToolCall("mcp", { intent: "list", server: "secretecho", reason: "check" });
	const restart = () => fauxToolCall("mcp", { intent: "restart", server: "secretecho", reason: "recover" });
	const calls = (...blocks: ReturnType<typeof fauxToolCall>[]) =>
		step(fauxAssistantMessage(blocks, { stopReason: "toolUse" }));
	const killed: number[] = [];
	faux.setResponses([
		calls(echo()),
		async () => {
			// Mid-session: the server process dies between two requests.
			killed.push(...mine());
			for (const pid of killed) process.kill(pid, "SIGKILL");
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			return fauxAssistantMessage([list()], { stopReason: "toolUse" });
		},
		calls(echo()),
		calls(restart()),
		calls(echo()),
		step(fauxAssistantMessage("done")),
	]);
	await agent.prompt("Use the echo service, then again.");
	expect(killed, "one server process was running and is now killed").toHaveLength(1);
	const results = agent.messages.filter((message) => message.role === "toolResult");
	const text = results.map((result) => JSON.stringify(result.content));
	expect(results).toHaveLength(5);
	// Before the drop the call works.
	expect(results[0]).toMatchObject({ toolName: "mcp__secretecho__echo_secret", isError: false });
	expect(text[0]).toContain(TOKEN);
	// After it, the server is listed as disconnected, and a call says so and names the way back instead of hanging.
	expect(results[1]).toMatchObject({ toolName: "mcp", isError: false });
	expect(text[1]).toMatch(/secretecho: disconnected/);
	expect(results[2]).toMatchObject({ toolName: "mcp__secretecho__echo_secret", isError: true });
	expect(text[2]).toMatch(/disconnected[\s\S]*reconnecting[\s\S]*intent \\"restart\\"/);
	expect(text[2]).not.toContain(TOKEN);
	// `restart` brings it back (a new process), and the next call returns the token again.
	expect(results[3]).toMatchObject({ toolName: "mcp", isError: false });
	expect(text[3]).toMatch(/Restarted\. secretecho: connected/);
	expect(results[4]).toMatchObject({ toolName: "mcp__secretecho__echo_secret", isError: false });
	expect(text[4]).toContain(TOKEN);
	expect(mine()).toHaveLength(1);
	expect(mine()).not.toContain(killed[0]);
});

/** True while a process with this pid exists. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

it("stops the stdio server process when the session is torn down through the runtime", async () => {
	const before = new Set(liveStdioServerPids());
	const { agent, faux, step, dispose } = await startMultiToolSession({}, SERVER, "secretecho");
	faux.setResponses([
		step(fauxAssistantMessage([fauxToolCall("mcp__secretecho__echo_secret", {})], { stopReason: "toolUse" })),
		step(fauxAssistantMessage("done")),
	]);
	await agent.prompt("Use the echo service.");
	const mine = liveStdioServerPids().filter((pid) => !before.has(pid));
	expect(mine, "the session started one stdio server").toHaveLength(1);
	expect(mine.every(alive)).toBe(true);

	await dispose();

	const deadline = Date.now() + 5_000;
	while (mine.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
	expect(mine.filter(alive), "server pids still running after teardown").toEqual([]);
});
