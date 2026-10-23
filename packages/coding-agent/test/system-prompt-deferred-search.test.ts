import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, getSystemMessageText } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createToolSearchExtension } from "../src/extensions/tool-search/index.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("leaves out the shell-search rule when tool_search can load an Octocode search tool", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-deferred-search-"));
	roots.push(root);
	const faux = createFauxCore({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4096 }] });
	const extension: ExtensionFactory = (pi) => {
		pi.registerProvider("faux", {
			name: "Faux",
			api: faux.api,
			baseUrl: "http://127.0.0.1:0",
			apiKey: "test",
			models: faux.models,
			streamSimple: faux.streamSimple,
		} as never);
		pi.registerTool({
			name: "mcp__octocode__localSearch",
			label: "Search",
			description: "Search local code.",
			exposure: "deferred",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		});
	};
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: path.join(root, "agent"),
		settingsManager,
		extensionFactories: [
			{ name: "fixture", factory: extension },
			{ name: "builtin:tool-search", factory: createToolSearchExtension() },
		],
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		noSkills: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: path.join(root, "agent"),
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(root),
		tools: ["bash", "tool_search"],
	});
	try {
		await session.bindExtensions({ mode: "json", shutdownHandler: () => undefined } as never);
		await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
		let prompt = "";
		faux.setResponses([
			(context) => {
				prompt = context.messages
					.filter((message) => message.role === "system")
					.map((message) => getSystemMessageText(message))
					.join("\n");
				return fauxAssistantMessage("ok");
			},
		]);
		await session.prompt("Find the parser.");
		expect(prompt).toContain("<rules>");
		expect(prompt).not.toContain("Use bash for file operations");
	} finally {
		session.dispose();
	}
});
