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
import { createMcpFeature } from "../../../mcp/src/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestSession } from "../helpers/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { tmp } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

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
		api: "anthropic-messages",
		models: [{ id: "cache", contextWindow: 200000, maxTokens: 4096 }],
	});
	faux.setResponses([fauxAssistantMessage("DONE"), fauxAssistantMessage("AGAIN")]);
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		nativeFeatures: nativeFeatureSet(),
		noPromptTemplates: true,
		noThemes: true,
		features: testFeatures([
			{ name: "mcp", factory: createMcpFeature() },
			{
				name: "cache-fixture",
				factory: (api) =>
					api.providers.register("faux-cache", {
						name: "Fixture",
						api: faux.api,
						baseUrl: "http://127.0.0.1:0",
						apiKey: "test",
						models: faux.models.map((model) => ({
							...model,
							// A flagship model takes tool and system changes after the cached prefix, so on-demand tools stay out of it.
							compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
						})),
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
		]),
	});
	await resourceLoader.reload();
	const { session } = await createTestSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.create(cwd, path.join(home, "sessions", project)),
	});
	await session.bindFeatures({
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
		await session.featureHost.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
	expect(captured).toHaveLength(2);
	return [captured[0], captured[1]];
}

/** The leading system prompt split where the second instruction cache block and the volatile block start. */
function layers({ context, options }: Captured) {
	const initial = getInitialSystemMessage(context.messages);
	const sections = initial?.sections ?? {};
	const names = Object.keys(sections);
	const boundary = options?.instructionCacheBoundary;
	const volatileBoundary = options?.instructionVolatileBoundary;
	const split = boundary ? names.indexOf(boundary) : -1;
	const tail = volatileBoundary ? names.indexOf(volatileBoundary) : names.length;
	const first = names.slice(0, split);
	const text = (part: string[]) => part.map((name) => sections[name] ?? "").join("");
	return {
		boundary,
		volatileBoundary,
		firstNames: first,
		first: first.map((name) => sections[name]).join(""),
		second: text(names.slice(split, tail)),
		volatileNames: names.slice(tail),
		volatile: text(names.slice(tail)),
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
	expect(a.firstNames).toContain("mcps");
	expect(a.toolNames).toContain("mcp__echo__shout");
	expect(a.toolNames.some((name) => name.startsWith("mcp__browser__"))).toBe(false);
	// The first session-tier section starts the second block; `project_context` follows the policy (`system-prompt-spec.ts`).
	expect(a.boundary).toBe("work");
	expect(a.first).not.toMatch(/project-a|Date: /);
	expect(a.second).toContain("Rules that only project-a has.");
	// The directory and the date sit in the third block, which has no breakpoint: neither cached block names them.
	expect(a.volatileBoundary).toBe("cwd");
	expect(a.volatileNames.slice(0, 3)).toEqual(["cwd", "environment", "environment:platform"]);
	expect(a.volatile).toMatch(/project-a/);
	expect(a.volatile).toMatch(/Date: /);
	expect(a.second).not.toMatch(/<cwd>|Date: /);
	// Everything the provider caches ahead of the project is the same in both projects.
	expect(b.tools).toBe(a.tools);
	expect(b.firstNames).toEqual(a.firstNames);
	expect(b.first).toBe(a.first);
	expect(b.second).not.toBe(a.second);
	// A later turn with nothing changed sends no prompt or tool update: the cached prefix only grows.
	expect(secondA.context.messages.filter((message) => message.role === "system")).toHaveLength(1);
	expect(layers(secondA).tools).toBe(a.tools);
}, 60_000);
