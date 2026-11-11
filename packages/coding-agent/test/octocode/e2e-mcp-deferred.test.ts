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
 * A workspace MCP server with `exposure: "deferred"` on a scripted model: the first request lists the server's purpose
 * and tool triggers only, the model loads the tool's full text with the `mcp` tool, then calls the tool. Every request
 * keeps the same system prompt and declarations: the loaded text arrives as a tool result, never in the prefix.
 */
const SERVER = path.join(import.meta.dirname, "fixtures", "echo-secret-mcp.mjs");
const TOKEN = "EXT-MCP-OK-7731";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

it("loads a deferred tool's text on demand, then calls it, without changing the cached prefix", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-e2e-deferred-"));
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
				secretecho: {
					command: process.execPath,
					args: [SERVER],
					exposure: "deferred",
					description: "Reads the secret echo service token.",
				},
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
	faux.setResponses([
		step(
			fauxAssistantMessage(
				[fauxToolCall("mcp", { intent: "tools", server: "secretecho", tool: "echo_secret", reason: "load" })],
				{ stopReason: "toolUse" },
			),
		),
		step(
			fauxAssistantMessage([fauxToolCall("mcp__secretecho__echo_secret", {})], {
				stopReason: "toolUse",
			}),
		),
		step(fauxAssistantMessage("done")),
	]);
	await agent.prompt("What does the secret echo service return?");
	expect(requests).toHaveLength(3);

	// The first request: a thin declaration and an index block that keeps the server's instructions.
	const prefix = (context: TranscriptContext) =>
		JSON.stringify({
			system: getCurrentSystemMessage(context.messages),
			tools: getCurrentTools(context.messages),
		});
	const sections = (getCurrentSystemMessage(requests[0].messages)?.sections ?? {}) as Record<string, string>;
	expect(getCurrentTools(requests[0].messages).map((tool) => tool.name)).toContain("mcp__secretecho__echo_secret");
	expect(sections.mcps).toContain(
		'<mcp name="secretecho" tools="mcp__secretecho__*">\nReads the secret echo service token.\nSecret echo service. Call echo_secret to read the service token.\n- echo_secret\n</mcp>',
	);
	expect(sections.mcps).not.toContain("declare namespace");
	expect(sections.mcps).not.toContain("additionalProperties");

	// The load returned the full upstream description and schema as a tool result.
	const results = agent.messages.filter((message) => message.role === "toolResult");
	expect(results[0]).toMatchObject({ toolName: "mcp", isError: false });
	expect(JSON.stringify(results[0]?.content)).toContain(
		"echo_secret [deferred] — Return the secret echo service token.",
	);
	expect(JSON.stringify(results[0]?.content)).toContain("additionalProperties");

	// The call ran and its result reached the model.
	expect(results[1]).toMatchObject({ toolName: "mcp__secretecho__echo_secret", isError: false });
	expect(JSON.stringify(results[1]?.content)).toContain(TOKEN);
	expect(JSON.stringify(requests[2].messages.filter((message) => message.role === "toolResult"))).toContain(TOKEN);

	// T5: every request carries the same system prompt and declarations.
	expect(prefix(requests[1])).toBe(prefix(requests[0]));
	expect(prefix(requests[2])).toBe(prefix(requests[0]));
});
