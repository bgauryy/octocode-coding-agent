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
import { afterEach, expect, it } from "vitest";
import type { FeatureRegister } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { sectionFamilyText } from "../../src/core/system-prompt-spec.ts";
import { createTestSession } from "../helpers/session.ts";
import { trustFolder } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

/**
 * A workspace MCP server with `exposure: "deferred"` on a scripted model: the first request lists the server's purpose
 * and tool triggers only, the model loads the tool's full text, receives a local rejection, and corrects the call. Every request
 * keeps the same system prompt and declarations: the loaded text arrives as a tool result, never in the prefix.
 */
const SERVER = path.join(import.meta.dirname, "fixtures", "echo-mcp.mjs");
const TOOL = "mcp__echo__pick";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

it("loads a deferred contract and corrects a rejected nested field without changing the cached prefix", async () => {
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
				echo: {
					command: process.execPath,
					args: [SERVER],
					exposure: "deferred",
					description: "Echo test queries.",
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
	const provider: FeatureRegister = (api) => {
		api.providers.register("faux", {
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
		nativeFeatures: nativeFeatureSet(),
		features: testFeatures([{ name: "faux-provider", factory: provider }]),
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
	cleanups.push(() => {
		agent.dispose?.();
		process.env.HOME = saved.HOME;
		if (saved.agentDir === undefined) delete process.env.OCTOCODE_CODING_AGENT_DIR;
		else process.env.OCTOCODE_CODING_AGENT_DIR = saved.agentDir;
		if (saved.permission === undefined) delete process.env.OCTOCODE_PERMISSION;
		else process.env.OCTOCODE_PERMISSION = saved.permission;
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	await agent.bindFeatures({ mode: "json", shutdownHandler: () => undefined } as never);
	await agent.setModel(agent.modelRuntime.getModel("faux", "faux-1")!);

	const requests: TranscriptContext[] = [];
	const step = (response: ReturnType<typeof fauxAssistantMessage>) => (context: TranscriptContext) => {
		requests.push(context);
		return response;
	};
	faux.setResponses([
		step(
			fauxAssistantMessage([fauxToolCall("mcp", { intent: "tools", server: "echo", tool: "pick", reason: "load" })], {
				stopReason: "toolUse",
			}),
		),
		step(
			fauxAssistantMessage([fauxToolCall(TOOL, { queries: [{ operation: "tree", depthValue: 2 }] })], {
				stopReason: "toolUse",
			}),
		),
		step(
			fauxAssistantMessage([fauxToolCall(TOOL, { queries: [{ operation: "tree", depth: 2 }] })], {
				stopReason: "toolUse",
			}),
		),
		step(fauxAssistantMessage("done")),
	]);
	await agent.prompt("Echo a tree query with depth 2.");
	expect(requests).toHaveLength(4);

	// The first request: a thin declaration and an index block that keeps the server's instructions.
	const prefix = (context: TranscriptContext) =>
		JSON.stringify({
			system: getCurrentSystemMessage(context.messages),
			tools: getCurrentTools(context.messages),
		});
	const raw = (getCurrentSystemMessage(requests[0].messages)?.sections ?? {}) as Record<string, string>;
	// The head and each server's `mcps:<server>` block, joined.
	const sections = { ...raw, mcps: sectionFamilyText(raw, "mcps") };
	expect(getCurrentTools(requests[0].messages).map((tool) => tool.name)).toContain(TOOL);
	expect(sections.mcps).toContain('<mcp name="echo" tools="mcp__echo__*">\nEcho test queries.\nEcho test server.');
	expect(sections.mcps).toContain("\n- pick\n");
	expect(sections.mcps).not.toContain("declare namespace");
	expect(sections.mcps).not.toContain("additionalProperties");

	// The load returned the full upstream description and schema as a tool result.
	const results = agent.messages.filter((message) => message.role === "toolResult");
	expect(results[0]).toMatchObject({ toolName: "mcp", isError: false });
	expect(JSON.stringify(results[0]?.content)).toContain("pick [deferred] — Echo union queries back");
	expect(JSON.stringify(results[0]?.content)).toContain("additionalProperties");

	// The next request sees the refusal. The corrected call returns exactly the nested query the server received.
	expect(results).toHaveLength(3);
	expect(results[1]).toMatchObject({ toolName: TOOL, isError: true });
	expect(JSON.stringify(requests[2].messages.filter((message) => message.role === "toolResult"))).toContain(
		"depthValue",
	);
	expect(results[2]).toMatchObject({ toolName: TOOL, isError: false });
	const echoed = '[{"operation":"tree","depth":2}]';
	expect(results[2].content).toContainEqual({ type: "text", text: echoed });
	const delivered = requests[3].messages.findLast((message) => message.role === "toolResult");
	expect(delivered?.content).toContainEqual({ type: "text", text: expect.stringContaining(echoed) });

	for (const request of requests.slice(1)) expect(prefix(request)).toBe(prefix(requests[0]));
});
