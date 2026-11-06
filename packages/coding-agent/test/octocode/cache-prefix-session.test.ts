// B114: what a native session caches ahead of its history (tool declarations and the leading system prompt, skills and
// the `<mcps>` block included) is byte-identical on every turn and after a compaction, so the instruction breakpoint
// keeps reading the same entry. The adapter side of the same contract is in packages/ai/test/history-prefix-stability.
import fs from "node:fs";
import path from "node:path";
import {
	type Context,
	createFauxCore,
	fauxAssistantMessage,
	getInitialSystemMessage,
	getSystemMessageText,
	type SimpleStreamOptions,
} from "@octocodeai/octocode-ai";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpExtension } from "../../../mcp/src/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestSession } from "../helpers/session.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

const echoServer = path.resolve(import.meta.dirname, "fixtures/echo-mcp.mjs");

interface Captured {
	context: Context;
	options?: SimpleStreamOptions;
}

function head({ context, options }: Captured) {
	const initial = getInitialSystemMessage(context.messages);
	return {
		sections: Object.keys(initial?.sections ?? {}),
		system: initial ? getSystemMessageText(initial) : "",
		tools: JSON.stringify(initial?.toolsAdded ?? []),
		boundary: options?.instructionCacheBoundary,
		cacheRetention: options?.cacheRetention,
		instructionCacheRetention: options?.instructionCacheRetention,
	};
}

it("sends the same tools and leading prompt on every turn and after a compaction", async () => {
	const root = tmp("cache-prefix-");
	const home = path.join(root, "home");
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# project\nProject rules.\n");
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

	const captured: Captured[] = [];
	const faux = createFauxCore({
		provider: "faux-cache",
		models: [{ id: "cache", contextWindow: 200000, maxTokens: 4096 }],
	});
	faux.setResponses([
		fauxAssistantMessage("DONE"),
		fauxAssistantMessage("AGAIN"),
		fauxAssistantMessage("## Goal\nSummary of the earlier turns."),
		fauxAssistantMessage("AFTER"),
	]);
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	// Keep almost nothing as recent history, so the short fixture conversation has something to compact.
	const policy = settingsManager.getCompactionSettings();
	settingsManager.getCompactionSettings = () => ({ ...policy, keepRecentTokens: 1 });
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
	const { session } = await createTestSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.create(cwd, path.join(home, "sessions")),
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
		await session.compact();
		await session.prompt("After compaction.");
	} finally {
		await session.abort("shutdown");
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}

	// Two turns, the compaction summary (sent with the session's own prompt and tools, so it reads their entry), one turn.
	const turns = captured.filter((request) => head(request).sections.includes("cwd"));
	expect(turns).toHaveLength(4);
	const [first, ...later] = turns.map(head);
	expect(first.sections).toContain("mcps");
	expect(first.tools).toContain("mcp__echo__shout");
	for (const turn of later) {
		expect(turn.tools).toBe(first.tools);
		expect(turn.system).toBe(first.system);
		expect(turn.sections).toEqual(first.sections);
		expect(turn.boundary).toBe(first.boundary);
		expect([turn.cacheRetention, turn.instructionCacheRetention]).toEqual([
			first.cacheRetention,
			first.instructionCacheRetention,
		]);
	}
	// Nothing changed, so no prompt or tool update entered the conversation: the cached prefix only grew.
	for (const turn of [turns[0], turns[1], turns[3]])
		expect(turn.context.messages.filter((message) => message.role === "system")).toHaveLength(1);
	// The compaction really replaced the history.
	const userTexts = JSON.stringify(turns[3].context.messages.filter((message) => message.role === "user"));
	expect(userTexts).toContain("Summary of the earlier turns.");
}, 60_000);
