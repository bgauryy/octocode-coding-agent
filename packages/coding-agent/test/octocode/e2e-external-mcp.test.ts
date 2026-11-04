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
import { afterEach, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestSession } from "../helpers/session.ts";
import { trustFolder } from "./helpers.ts";

/**
 * An external stdio MCP server the user adds to the trusted workspace's `.octocode/mcp.json`, with no `exposure`
 * setting (the default), on a scripted model: the agent's first request declares and describes its tool, a scripted
 * call returns the server's token, and the next request carries that token to the model.
 */
const SERVER = path.join(import.meta.dirname, "fixtures", "echo-secret-mcp.mjs");
const TOKEN = "EXT-MCP-OK-7731";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

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
	await resourceLoader.reload();
	const { session: agent } = await createTestSession({
		cwd,
		agentDir,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	cleanups.push(() => {
		agent.dispose?.();
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
			fauxAssistantMessage([fauxToolCall("mcp__secretecho__echo_secret", { reason: "scripted e2e step" })], {
				stopReason: "toolUse",
			}),
		),
		step(fauxAssistantMessage("done")),
	]);
	await agent.prompt("What does the secret echo service return?");
	expect(requests).toHaveLength(2);

	// Exposure: a native function declaration, plus a block in the cached `mcps` section.
	const first = requests[0];
	const sections = (getCurrentSystemMessage(first.messages)?.sections ?? {}) as Record<string, string>;
	expect(getCurrentTools(first.messages).map((tool) => tool.name)).toContain("mcp__secretecho__echo_secret");
	expect(sections.mcps).toContain('<mcp name="secretecho" tools="mcp__secretecho__*">');
	expect(sections.mcps).toContain("Secret echo service. Call echo_secret to read the service token.");
	expect(sections.mcps).toContain("Return the secret echo service token.");

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

async function startMultiToolSession(serverConfig: Record<string, unknown>) {
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
				inventory: { command: process.execPath, args: [MULTI], ...serverConfig },
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
	await resourceLoader.reload();
	const { session: agent } = await createTestSession({
		cwd,
		agentDir,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	cleanups.push(() => {
		agent.dispose?.();
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
		step(
			fauxAssistantMessage([fauxToolCall(name, { ...args, reason: "scripted e2e step" })], { stopReason: "toolUse" }),
		);
	const mcpBlock = () => {
		const sections = (getCurrentSystemMessage(requests[0].messages)?.sections ?? {}) as Record<string, string>;
		const start = sections.mcps.indexOf('<mcp name="inventory"');
		return sections.mcps.slice(start, sections.mcps.indexOf("</mcp>", start) + "</mcp>".length);
	};
	return { agent, faux, requests, step, toolCall, mcpBlock };
}

it("tells the agent a default-exposed server's instructions and every tool, description and field", async () => {
	const { agent, faux, requests, step, toolCall, mcpBlock } = await startMultiToolSession({});
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
	for (const [name, tool] of Object.entries(TOOLS)) {
		expect(block, name).toContain(name);
		expect(block, name).toContain(tool.description);
		for (const [field, description] of Object.entries(tool.fields)) {
			expect(block, `${name}.${field}`).toContain(field);
			expect(block, `${name}.${field}`).toContain(description);
		}
	}
	for (const value of ENUM_VALUES) expect(block).toContain(value);

	const declared = getCurrentTools(requests[0].messages).map((tool) => tool.name);
	for (const name of Object.keys(TOOLS)) expect(declared).toContain(`mcp__inventory__${name}`);

	// A valid call succeeds; a wrong-type argument is refused with an error naming the field.
	const results = agent.messages.filter((message) => message.role === "toolResult");
	expect(results).toHaveLength(3);
	expect(results[0]).toMatchObject({ toolName: "mcp__inventory__search_items", isError: false });
	expect(JSON.stringify(results[0]?.content)).toContain("search_items ok");
	expect(results[1]).toMatchObject({ toolName: "mcp__inventory__search_items", isError: true });
	expect(JSON.stringify(results[1]?.content)).toContain("limit");
	expect(results[2]).toMatchObject({ toolName: "mcp__inventory__reserve_item", isError: false });
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
	for (const [name, tool] of Object.entries(TOOLS)) expect(block).toContain(`- ${name}: ${tool.description}`);
	expect(block).not.toContain("declare namespace");

	const result = agent.messages.find((message) => message.role === "toolResult");
	expect(result).toMatchObject({ toolName: "mcp", isError: false });
	const text = JSON.stringify(result?.content);
	expect(text).toContain(TOOLS.reserve_item.description);
	for (const description of Object.values(TOOLS.reserve_item.fields)) expect(text).toContain(description);
	for (const value of ENUM_VALUES) expect(text).toContain(value);
});
