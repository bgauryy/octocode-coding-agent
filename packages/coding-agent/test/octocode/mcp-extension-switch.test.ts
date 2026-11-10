import "../mcp-host.ts";
import fs from "node:fs";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, getCurrentTools } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { ExtensionFactory } from "../../src/core/features/index.ts";
import { buildInventory } from "../../src/octocode/harness/inventory.ts";
import { switchItem } from "../../src/core/extensibility/switch.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "../../src/core/settings-diagnostics.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { createTestSession } from "../helpers/session.ts";
import { tmp } from "./helpers.ts";

/**
 * A user-level `octocode` entry in the global mcp.json, as the developer has, and an `extensions` entry
 * `-builtin:mcp`. MCP is core: the entry is ignored with a settings warning, every session keeps the `mcp` tool and the
 * servers' tools, no switch lists MCP, and only `--no-mcp` turns it off.
 */
const SERVER = path.join(import.meta.dirname, "fixtures", "docs-mcp.mjs");
const OFF = ["-builtin:mcp"];

afterEach(() => vi.unstubAllEnvs());

function workspace() {
	const root = tmp("octocode-mcp-switch-");
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	const home = path.join(root, "home");
	for (const dir of [cwd, agentDir, home]) fs.mkdirSync(dir);
	fs.mkdirSync(path.join(cwd, ".git"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("OCTOCODE_HOME", path.join(home, ".octocode"));
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("OCTOCODE_OFFLINE", "1");
	// The user's global file: an `octocode` entry that runs a server of its own.
	fs.writeFileSync(
		path.join(agentDir, "mcp.json"),
		JSON.stringify({ mcpServers: { octocode: { command: process.execPath, args: [SERVER] } } }),
	);
	const writeSettings = (extensions: string[]) =>
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ extensions }));
	return { root, cwd, agentDir, writeSettings };
}

/** The tools a session declares to the model, and the loader's startup warnings, with the settings file as written. */
async function startSession(role: "main" | "researcher", extensions: string[], disabledFeatures?: string[]) {
	const w = workspace();
	w.writeSettings(extensions);
	vi.stubEnv("OCTOCODE_SUBAGENT", role === "main" ? "0" : "1");
	const faux = createFauxCore({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4096 }],
	});
	const provider: ExtensionFactory = (api) => {
		api.registerProvider("faux", {
			name: "Faux",
			api: faux.api,
			baseUrl: "http://127.0.0.1:0",
			apiKey: "test",
			models: faux.models,
			streamSimple: faux.streamSimple,
		} as never);
	};
	const settingsManager = SettingsManager.create(w.cwd, w.agentDir, { projectTrusted: false });
	const resourceLoader = new DefaultResourceLoader({
		cwd: w.cwd,
		agentDir: w.agentDir,
		settingsManager,
		extensionFactories: [{ name: "faux-provider", factory: provider }],
		...(disabledFeatures ? { disabledFeatures } : {}),
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		noSkills: true,
	});
	await resourceLoader.reload();
	const selection =
		role === "main"
			? parseArgs([])
			: parseArgs(
					buildAgentArgs(loadProfiles(w.cwd, w.agentDir, false, {}).get(role), undefined, {
						dir: path.join(w.root, "session"),
						id: "switch",
					}),
				);
	const { session } = await createTestSession({
		cwd: w.cwd,
		agentDir: w.agentDir,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(w.cwd),
		...(selection.tools ? { tools: selection.tools } : {}),
		...(selection.excludeTools ? { excludeTools: selection.excludeTools } : {}),
	});
	try {
		await session.bindExtensions({ mode: "json", shutdownHandler: () => undefined } as never);
		await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
		let declared: string[] = [];
		// The first prompt waits up to 10 s for the server; a slow start joins a later prompt.
		for (let attempt = 0; attempt < 6; attempt++) {
			faux.setResponses([
				(context) => {
					declared = getCurrentTools(context.messages).map((tool) => tool.name);
					return fauxAssistantMessage("ok");
				},
			]);
			await session.prompt("Which tools do you have?");
			if (disabledFeatures || declared.some((name) => name.startsWith("mcp__octocode__"))) break;
		}
		// Startup reports each settings diagnostic once, though the loader reloads the file.
		const settingsWarnings = deduplicateDiagnostics(collectSettingsDiagnostics(settingsManager)).map(
			(entry) => entry.message,
		);
		return { declared, settingsWarnings, settingsFile: path.join(w.agentDir, "settings.json") };
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
}

describe("a user `octocode` entry in the global mcp.json", () => {
	it.each(["main", "researcher"] as const)(
		"declares the mcp tool and the server's tools in the %s session",
		async (role) => {
			const { declared, settingsWarnings } = await startSession(role, []);
			expect(declared).toContain("mcp");
			expect(declared).toContain("mcp__octocode__lookup");
			expect(settingsWarnings).toEqual([]);
		},
		60_000,
	);

	it.each(["main", "researcher"] as const)(
		"still declares them in the %s session when `extensions` holds `-builtin:mcp`, which is ignored with one warning",
		async (role) => {
			const { declared, settingsWarnings, settingsFile } = await startSession(role, OFF);
			expect(declared).toContain("mcp");
			expect(declared).toContain("mcp__octocode__lookup");
			expect(settingsWarnings).toEqual([
				`${settingsFile}: "-builtin:mcp" in extensions is ignored: MCP is always on; turn servers off in /mcp or mcp.json, or start with --no-mcp`,
			]);
		},
		60_000,
	);

	it("is removed by `--no-mcp`, the operator's switch", async () => {
		const { declared } = await startSession("main", OFF, ["mcp"]);
		expect(declared).not.toContain("mcp");
		expect(declared.filter((name) => name.startsWith("mcp__"))).toEqual([]);
	}, 60_000);
});

describe("the built-in extension switch", () => {
	it("has no row for MCP, and describes what the llama.cpp row turns off", async () => {
		const w = workspace();
		const manager = SettingsManager.create(w.cwd, w.agentDir, { projectTrusted: false });
		const inventory = await buildInventory({
			cwd: w.cwd,
			agentDir: w.agentDir,
			settings: manager.getSettings(),
			manager,
			projectTrusted: false,
		});
		expect(inventory.items.find((item) => item.id === "extension:builtin:mcp")).toBeUndefined();
		const row = inventory.items.find((item) => item.id === "extension:builtin:llama.cpp");
		if (!row) throw new Error("no row for the llama.cpp built-in");
		expect(row.detail).toContain("switching it off turns off the local llama.cpp provider");
		const off = switchItem(row, false, "global", manager, { cwd: w.cwd, agentDir: w.agentDir });
		expect(off).toContain("Switching it off turns off the local llama.cpp provider and its commands.");
		expect(switchItem(row, true, "global", manager, { cwd: w.cwd, agentDir: w.agentDir })).not.toContain(
			"Switching it off",
		);
	});
});
