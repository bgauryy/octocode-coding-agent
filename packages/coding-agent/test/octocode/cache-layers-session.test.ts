import fs from "node:fs";
import path from "node:path";
import {
	type Context,
	createFauxCore,
	fauxAssistantMessage,
	getInitialSystemMessage,
	type SimpleStreamOptions,
} from "@octocodeai/octocode-ai";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpExtension } from "../../../mcp/src/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

const echoServer = path.resolve(import.meta.dirname, "fixtures/echo-mcp.mjs");

interface Captured {
	context: Context;
	options?: SimpleStreamOptions;
}

/**
 * One native session in its own project, with the same global agent directory (the `echo` MCP server in `mcp.json`) as
 * every other call. Prompts twice and returns both requests the provider received.
 */
async function twoRequests(agentDir: string, home: string, project: string): Promise<[Captured, Captured]> {
	const cwd = path.join(path.dirname(agentDir), project);
	fs.mkdirSync(cwd, { recursive: true });
	fs.writeFileSync(path.join(cwd, "AGENTS.md"), `# ${project}\nRules that only ${project} has.\n`);
	const captured: Captured[] = [];
	const faux = createFauxCore({
		provider: "faux-cache",
		models: [{ id: "cache", contextWindow: 200000, maxTokens: 4096 }],
	});
	faux.setResponses([fauxAssistantMessage("DONE"), fauxAssistantMessage("AGAIN")]);
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [
			{ name: "mcp", factory: createMcpExtension() },
			{
				name: "cache-fixture",
				factory: (api) =>
					api.registerProvider("faux-cache", {
						name: "Fixture",
						api: faux.api,
						baseUrl: "http://127.0.0.1:0",
						apiKey: "test",
						models: faux.models,
						streamSimple: (
							model: Parameters<typeof faux.streamSimple>[0],
							context: Parameters<typeof faux.streamSimple>[1],
							options?: SimpleStreamOptions,
						) => {
							captured.push({ context: structuredClone(context), options });
							return faux.streamSimple(model, context, options);
						},
					} as never),
			},
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.create(cwd, path.join(home, "sessions", project)),
	});
	await session.bindExtensions({
		mode: "json",
		uiContext: { confirm: async () => true, notify: () => undefined } as never,
		shutdownHandler: () => undefined,
	} as never);
	await session.setModel(session.modelRuntime.getModel("faux-cache", "cache")!);
	try {
		await session.prompt("Hello.");
		await session.prompt("Again.");
	} finally {
		await session.abort("shutdown");
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
	expect(captured).toHaveLength(2);
	return [captured[0], captured[1]];
}

/** The leading system prompt split where the second instruction cache block starts. */
function layers({ context, options }: Captured) {
	const initial = getInitialSystemMessage(context.messages);
	const sections = initial?.sections ?? {};
	const names = Object.keys(sections);
	const boundary = options?.instructionCacheBoundary;
	const split = boundary ? names.indexOf(boundary) : -1;
	const first = names.slice(0, split);
	return {
		boundary,
		firstNames: first,
		first: first.map((name) => sections[name]).join(""),
		second: names
			.slice(split)
			.map((name) => sections[name] ?? "")
			.join(""),
		// Tools reach the provider as the leading system message's declarations.
		toolNames: (initial?.toolsAdded ?? []).map((tool) => tool.name),
		tools: JSON.stringify(initial?.toolsAdded ?? []),
	};
}

it("sends byte-identical tools and first instruction block from different projects", async () => {
	const root = tmp("cache-layers-");
	const home = path.join(root, "home");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentDir, "mcp.json"),
		JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [echoServer] } } }),
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
	}))
		vi.stubEnv(key, value);

	const [firstA, secondA] = await twoRequests(agentDir, home, "project-a");
	const a = layers(firstA);
	const b = layers((await twoRequests(agentDir, home, "project-b"))[0]);

	// The server's file is part of the stable block, which ends before anything project- or day-specific.
	expect(a.firstNames).toContain("mcp_contract_echo");
	expect(a.toolNames).toContain("mcp__echo__shout");
	expect(a.toolNames.some((name) => name.startsWith("mcp__browser__"))).toBe(false);
	expect(a.boundary).toBe("project_context");
	expect(a.first).not.toMatch(/project-a|Date: /);
	expect(a.second).toContain("Rules that only project-a has.");
	// Everything the provider caches ahead of the project is the same in both projects.
	expect(b.tools).toBe(a.tools);
	expect(b.firstNames).toEqual(a.firstNames);
	expect(b.first).toBe(a.first);
	expect(b.second).not.toBe(a.second);
	// A later turn with nothing changed sends no prompt or tool update: the cached prefix only grows.
	expect(secondA.context.messages.filter((message) => message.role === "system")).toHaveLength(1);
	expect(layers(secondA).tools).toBe(a.tools);
}, 60_000);
