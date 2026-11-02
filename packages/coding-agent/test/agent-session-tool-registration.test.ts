import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/features/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createTestSession } from "./helpers/session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const tool = (name: string, exposure: ToolDefinition["exposure"] = "direct"): ToolDefinition => ({
	name,
	label: name,
	description: name,
	parameters: Type.Object({}),
	exposure,
	execute: async () => ({ content: [{ type: "text", text: name }], details: undefined }),
});

describe("AgentSession tool registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "octocode-tool-registration-"));
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	async function session(register: (api: ExtensionAPI) => void) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [register],
		});
		await resourceLoader.reload();
		const { session } = await createTestSession({
			cwd: tempDir,
			agentDir,
			model: getBuiltinModel("anthropic", "claude-sonnet-4-5"),
			settingsManager,
			sessionManager: SessionManager.create(tempDir, join(agentDir, "sessions"), { id: "registration" }),
			resourceLoader,
		});
		await session.bindExtensions({});
		return session;
	}

	it("registerTools makes every tool of a catalog available with one registry refresh", async () => {
		let host: ExtensionAPI | undefined;
		let refreshes = 0;
		const live = await session((api) => {
			host = api;
			// Every registry refresh rebuilds the loadout, which runs each active tool's public `prepareLoadout` hook once.
			api.registerTool({
				...tool("loadout_probe"),
				prepareLoadout: () => {
					refreshes++;
					return undefined;
				},
			});
		});
		refreshes = 0;

		host!.registerTools(Array.from({ length: 25 }, (_, index) => tool(`catalog_${index}`)));

		expect(refreshes).toBe(1);
		for (let index = 0; index < 25; index++) expect(live.getActiveToolNames()).toContain(`catalog_${index}`);
		host!.registerTools([]);
		expect(refreshes).toBe(1);
	});

	it("registerTools stores nothing when one definition is invalid", async () => {
		let host: ExtensionAPI | undefined;
		const live = await session((api) => {
			host = api;
		});
		const bad = { ...tool("bad_tool"), parameters: undefined } as unknown as ToolDefinition;

		expect(() => host!.registerTools([tool("good_tool"), bad])).toThrow(/object parameter schema/);

		expect(live.getAllTools().map((entry) => entry.name)).not.toContain("good_tool");
	});

	// What `registerTools`/`hideTools` in packages/mcp do when a server drops and re-offers its tools; the same
	// refresh path serves every extension tool, so a non-MCP tool and a model-only one must behave alike.
	for (const [name, exposure] of [
		["mcp__srv__a", "direct"],
		["mcp__srv__m", "model-only"],
		["plain_tool", "direct"],
	] as const) {
		it(`keeps a deselected ${exposure} tool ${name} inactive when it is withdrawn (hidden) and registered again`, async () => {
			let host: ExtensionAPI | undefined;
			const live = await session((api) => {
				host = api;
				api.registerTool(tool(name, exposure));
				api.registerTool(tool("mcp__srv__b"));
			});
			expect(live.getActiveToolNames()).toContain(name);

			live.setActiveToolsByName(live.getActiveToolNames().filter((active) => active !== name));
			expect(live.getActiveToolNames()).not.toContain(name);

			host!.registerTool(tool(name, "hidden"));
			host!.registerTool(tool(name, exposure));

			expect(live.getActiveToolNames()).toContain("mcp__srv__b");
			expect(live.getActiveToolNames()).not.toContain(name);

			// Selecting it again lifts the deselection.
			live.setActiveToolsByName([...live.getActiveToolNames(), name]);
			expect(live.getActiveToolNames()).toContain(name);
		});
	}

	it("reactivates a tool the user kept when its server withdraws and re-offers it", async () => {
		let host: ExtensionAPI | undefined;
		const live = await session((api) => {
			host = api;
			api.registerTool(tool("mcp__srv__a"));
		});
		host!.registerTool(tool("mcp__srv__a", "hidden"));
		expect(live.getActiveToolNames()).not.toContain("mcp__srv__a");
		host!.registerTool(tool("mcp__srv__a", "direct"));
		expect(live.getActiveToolNames()).toContain("mcp__srv__a");
	});
});
