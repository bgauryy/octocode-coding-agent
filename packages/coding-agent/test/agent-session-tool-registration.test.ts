import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
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

	async function session(register: (pi: ExtensionAPI) => void) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [register],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
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
		let pi: ExtensionAPI | undefined;
		const live = await session((api) => {
			pi = api;
		});
		let refreshes = 0;
		// The runner keeps the shared runtime privately; wrap the refresh hook every registration calls.
		const runtime = (live.extensionRunner as unknown as { runtime: { refreshTools: () => void } }).runtime;
		const refresh = runtime.refreshTools;
		runtime.refreshTools = () => {
			refreshes++;
			refresh();
		};

		pi!.registerTools(Array.from({ length: 25 }, (_, index) => tool(`catalog_${index}`)));

		expect(refreshes).toBe(1);
		for (let index = 0; index < 25; index++) expect(live.getActiveToolNames()).toContain(`catalog_${index}`);
		pi!.registerTools([]);
		expect(refreshes).toBe(1);
	});

	it("registerTools stores nothing when one definition is invalid", async () => {
		let pi: ExtensionAPI | undefined;
		const live = await session((api) => {
			pi = api;
		});
		const bad = { ...tool("bad_tool"), parameters: undefined } as unknown as ToolDefinition;

		expect(() => pi!.registerTools([tool("good_tool"), bad])).toThrow(/object parameter schema/);

		expect(live.getAllTools().map((entry) => entry.name)).not.toContain("good_tool");
	});

	// C-10 (audit lane C, B155) is real: refresh() in core/agent-session/tool-loadout.ts activates a tool whose exposure
	// flips hidden -> direct as a new registration. The fix belongs there (held by another agent); `it.fails` turns
	// into an error when it lands, so remove the `.fails` then.
	it.fails("keeps a deselected direct tool inactive when it is withdrawn (hidden) and registered again", async () => {
		let pi: ExtensionAPI | undefined;
		const live = await session((api) => {
			pi = api;
			api.registerTool(tool("mcp__srv__a"));
			api.registerTool(tool("mcp__srv__b"));
		});
		expect(live.getActiveToolNames()).toContain("mcp__srv__a");

		live.setActiveToolsByName(live.getActiveToolNames().filter((name) => name !== "mcp__srv__a"));
		expect(live.getActiveToolNames()).not.toContain("mcp__srv__a");

		// What `registerTools`/`hideTools` in packages/mcp do when the server drops and re-offers its tools.
		pi!.registerTool(tool("mcp__srv__a", "hidden"));
		pi!.registerTool(tool("mcp__srv__a", "direct"));

		expect(live.getActiveToolNames()).toContain("mcp__srv__b");
		expect(live.getActiveToolNames()).not.toContain("mcp__srv__a");
	});
});
