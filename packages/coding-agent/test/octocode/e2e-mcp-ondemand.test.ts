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
import { afterEach, expect, it, vi } from "vitest";
import type { FeatureRegister } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestSession } from "../helpers/session.ts";
import { trustFolder } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

/**
 * A workspace MCP server whose tool has `toolExposure: "onDemand"`, on a scripted model. Where the transport adds tools
 * after the cached prefix (Anthropic-style tool changes), the tool is not declared at first: the block lists it by name
 * and trigger, and a load with the `mcp` tool or a first call declares it after the prefix, which stays byte-identical.
 * Elsewhere the tool is declared deferred from the first request.
 */
const SERVER = path.join(import.meta.dirname, "fixtures", "echo-secret-mcp.mjs");
const TOKEN = "EXT-MCP-OK-7731";
const TOOL = "mcp__secretecho__echo_secret";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function startSession(capable: boolean) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-e2e-ondemand-"));
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
					toolExposure: { echo_secret: "onDemand" },
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
		...(capable ? { api: "anthropic-messages" } : {}),
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
				...(capable ? { compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } } : {}),
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
	// A fast server can finish registering before the first model is selected on either transport.
	await vi.waitFor(() =>
		expect(agent.featureHost.getAllRegisteredTools().some((tool) => tool.definition.name === TOOL)).toBe(true),
	);
	await agent.setModel(agent.modelRuntime.getModel("faux", "faux-1")!);

	return { agent, faux };
}

type Faux = Awaited<ReturnType<typeof startSession>>["faux"];

function script(faux: Faux, responses: ReturnType<typeof fauxAssistantMessage>[]): TranscriptContext[] {
	const requests: TranscriptContext[] = [];
	faux.setResponses(
		responses.map((response) => (context: TranscriptContext) => {
			requests.push(context);
			return response;
		}),
	);
	return requests;
}

/** The cached head: the leading system message (prompt and the tools it declares). */
const head = (context: TranscriptContext) => JSON.stringify(context.messages[0]);
const declared = (context: TranscriptContext) => getCurrentTools(context.messages).map((tool) => tool.name);
const resultText = (context: TranscriptContext) =>
	JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));

it("lists an on-demand tool undeclared, loads it with the mcp tool, then calls it without changing the cached head", async () => {
	const { agent, faux } = await startSession(true);
	const requests = script(faux, [
		fauxAssistantMessage(
			[fauxToolCall("mcp", { intent: "tools", server: "secretecho", tool: "echo_secret", reason: "load" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxToolCall(TOOL, {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await agent.prompt("What does the secret echo service return?");
	expect(requests).toHaveLength(3);
	expect(declared(requests[0])).not.toContain(TOOL);
	expect(declared(requests[0])).toContain("mcp");
	const sections = Object.entries(getCurrentSystemMessage(requests[0].messages)?.sections ?? {});
	// The `mcps` section, with each server's block when it is a section of its own (`mcps:<server>`).
	const mcps = sections
		.filter(([name]) => name === "mcps" || name.startsWith("mcps:"))
		.map(([, text]) => String(text))
		.join("\n");
	expect(mcps).toMatch(/- echo_secret: \S/);
	// Loading declares the tool after the head, which stays byte-identical.
	expect(head(requests[1])).toBe(head(requests[0]));
	expect(head(requests[2])).toBe(head(requests[0]));
	expect(declared(requests[1])).toContain(TOOL);
	const additions = requests[1].messages
		.slice(1)
		.filter((message) => message.role === "system" && message.toolsAdded?.some((tool) => tool.name === TOOL));
	expect(additions).toHaveLength(1);
	expect(resultText(requests[2])).toContain(TOKEN);
});

it("runs an on-demand tool the model calls before loading it, then declares it after the cached head", async () => {
	const { agent, faux } = await startSession(true);
	const requests = script(faux, [
		fauxAssistantMessage([fauxToolCall(TOOL, {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await agent.prompt("What does the secret echo service return?");
	expect(requests).toHaveLength(2);
	expect(declared(requests[0])).not.toContain(TOOL);
	expect(resultText(requests[1])).toContain(TOKEN);
	expect(resultText(requests[1])).not.toContain("not found");
	expect(head(requests[1])).toBe(head(requests[0]));
	expect(declared(requests[1])).toContain(TOOL);
});

it("declares an on-demand tool deferred from the first request where the transport cannot add tools in place", async () => {
	const { agent, faux } = await startSession(false);
	const requests = script(faux, [
		fauxAssistantMessage([fauxToolCall(TOOL, {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await agent.prompt("What does the secret echo service return?");
	expect(requests).toHaveLength(2);
	expect(declared(requests[0])).toContain(TOOL);
	expect(head(requests[1])).toBe(head(requests[0]));
	expect(resultText(requests[1])).toContain(TOKEN);
});
