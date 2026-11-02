import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	getCurrentSystemMessage,
	getCurrentTools,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { ExtensionFactory } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { parseProfile } from "../../src/octocode/subagents/profiles.ts";
import { createTestSession } from "../helpers/session.ts";
import { trustFolder } from "./helpers.ts";

/**
 * A user-configured stdio MCP server in a real session on a scripted model: its own instructions and, for each tool
 * enabled for the agent, the tool's description and schema are in the `<mcps>` section, in one block, whichever server
 * it is. Provider declarations of its tools stay thin. The sibling Octocode server is switched off here so the
 * section holds the one server (`fixtures/docs-mcp.mjs`).
 */
const SERVER = path.join(import.meta.dirname, "fixtures", "docs-mcp.mjs");
const OCTOCODE_OFF = { octocode: { command: "false", enabled: false } };

interface FirstRequest {
	sections: Record<string, string>;
	declared: ReturnType<typeof getCurrentTools>;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The first model request of a session that has the docs server (`docs` options added to its mcp.json entry). */
async function firstRequest(
	docs: Record<string, unknown> = {},
	session: { tools?: string[]; excludeTools?: string[]; settings?: Record<string, unknown> } = {},
): Promise<FirstRequest> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-e2e-mcps-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	trustFolder(cwd);
	fs.writeFileSync(
		path.join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				...OCTOCODE_OFF,
				docs: {
					command: process.execPath,
					args: [SERVER],
					exposure: "direct",
					description: "Product docs",
					...docs,
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
	// A headless session denies every ask: this user exported workspace.
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
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, ...session.settings });
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
		...(session.tools ? { tools: session.tools } : {}),
		...(session.excludeTools ? { excludeTools: session.excludeTools } : {}),
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
	let captured: TranscriptContext | undefined;
	faux.setResponses([
		(context: TranscriptContext) => {
			captured ??= context;
			return fauxAssistantMessage("ready");
		},
	]);
	await agent.prompt("hello");
	if (!captured) throw new Error("The scripted model received no request");
	return {
		sections: (getCurrentSystemMessage(captured.messages)?.sections ?? {}) as Record<string, string>,
		declared: getCurrentTools(captured.messages),
	};
}

const docsTools = (request: FirstRequest): string[] =>
	request.declared.map((tool) => tool.name).filter((name) => name.startsWith("mcp__docs__"));

describe("the mcps section of an agent with a user-configured MCP server", () => {
	it("holds the server's instructions and each enabled tool's description and schema", async () => {
		const request = await firstRequest({ toolExposure: { purge: "hidden" } });
		const mcps = request.sections.mcps;
		expect(mcps.startsWith('<mcps>\n<mcp name="docs" tools="mcp__docs__*">\n// MCP server "docs"')).toBe(true);
		expect(mcps.match(/<mcp /g)).toHaveLength(1);
		// The server's purpose is in the first list the model reads, once: the block does not repeat it.
		expect(request.sections.tools).toContain("\n- mcp__docs__*: Product docs\n");
		expect(mcps).not.toContain("Product docs");
		// The server's own instructions, whole.
		expect(mcps).toContain(
			"Docs server. Search with lookup before you publish. Never purge a published page; ask the user first.",
		);
		// Each enabled tool's description and schema (field docs, enum values, bounds, required fields).
		expect(mcps).toContain("Find a document by its title words. Returns the matching pages with their ids.");
		expect(mcps).toContain("Title words to search for.");
		expect(mcps).toContain('section?: "guide" | "api" | "changelog"');
		expect(mcps).toContain("(minimum 1, maximum 20)");
		expect(mcps).toMatch(/function lookup\(input: \{[^}]*query: string;/);
		expect(mcps).toContain("Publish a draft page so readers see it.");
		// A tool the TypeScript renderer cannot express (a $ref to a missing definition) is in the block as the server sent it.
		expect(mcps).toContain(
			'// mcp__docs__legacy\nImport a page from the old wiki.\nInput schema (JSON Schema): {"type":"object","properties":{"source":{"$ref":"#/$defs/missing"}',
		);
		// The tool the user turned off is absent everywhere (the instructions still say what the server says).
		expect(mcps).not.toContain("Delete a page permanently.");
		expect(mcps).not.toContain("function purge");
		expect(docsTools(request)).toEqual(["mcp__docs__legacy", "mcp__docs__lookup", "mcp__docs__publish"]);
		// No routing text of Octocode's own, and no status section while the server is connected.
		expect(mcps).not.toMatch(/declarations carry|Not connected/);
		expect(request.sections.mcp_status).toBeUndefined();
	});

	it("declares the tools thin: a trigger and top-level types, never a second copy of the schema", async () => {
		const request = await firstRequest({ toolExposure: { purge: "hidden" } });
		const lookup = request.declared.find((tool) => tool.name === "mcp__docs__lookup")!;
		expect(lookup.description).toBe("Find a document by its title words.");
		expect(lookup.parameters).toEqual({
			type: "object",
			properties: { query: { type: "string" }, limit: { type: "integer" }, section: { type: "string" } },
			additionalProperties: true,
		});
		// The plain-form tool is thin too: its schema is in the section.
		const legacy = request.declared.find((tool) => tool.name === "mcp__docs__legacy")!;
		expect(JSON.stringify(legacy.parameters)).not.toContain("$ref");
		const declarations = JSON.stringify(request.declared.filter((tool) => tool.name.startsWith("mcp__docs__")));
		for (const text of ["Title words to search for.", "Most pages to return.", "changelog", "Report only."])
			expect(declarations, text).not.toContain(text);
	});

	it("limits the block to the tools a role's allow-list enables", async () => {
		const profile = parseProfile(
			"docs-reader",
			"---\nname: docs-reader\ndescription: Reads the docs.\ntools: mcp__docs__lookup\n---\nRead the docs.\n",
		);
		const { tools, excludeTools } = parseArgs(
			buildAgentArgs(profile, undefined, { dir: os.tmpdir(), id: "child" }, []),
		);
		const request = await firstRequest({}, { tools, excludeTools });
		expect(docsTools(request)).toEqual(["mcp__docs__lookup"]);
		const mcps = request.sections.mcps;
		expect(mcps).toContain("Docs server. Search with lookup");
		expect(mcps).toContain("Title words to search for.");
		for (const left of ["function publish", "Publish a draft page", "legacy", "Import a page", "Delete a page"])
			expect(mcps, left).not.toContain(left);
	});

	it("describes every tool in plain form with mcpPresentation json, and still declares them thin", async () => {
		const request = await firstRequest(
			{ toolExposure: { purge: "hidden" } },
			{ settings: { mcpPresentation: "json" } },
		);
		const mcps = request.sections.mcps;
		expect(mcps).not.toContain("declare namespace");
		expect(mcps).toContain("Docs server. Search with lookup before you publish.");
		for (const tool of ["lookup", "publish", "legacy"]) expect(mcps).toContain(`// mcp__docs__${tool}\n`);
		expect(mcps).toContain('"query":{"type":"string","description":"Title words to search for."}');
		expect(mcps).not.toContain("Delete a page permanently.");
		const lookup = request.declared.find((tool) => tool.name === "mcp__docs__lookup")!;
		expect(JSON.stringify(lookup.parameters)).not.toContain("Title words");
	});
});
