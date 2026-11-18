import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { main } from "../src/main.ts";
import { handleConfigCommand } from "../src/package-manager-cli/config-command.ts";
import { type TestFeatureInput, testFeatures } from "./helpers/features.ts";
import { nativeFeatureSet } from "./helpers/native-features.ts";

describe("built-in composition", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	const exited = new Error("config closed");

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "octocode-builtins-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		vi.stubEnv("HOME", root);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw exited;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.clearAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	it.each(["main", "configuration"])("lists resources through %s despite a leftover extensions key", async (entry) => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }));
		const out: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line) => void out.push(String(line)));
		const args = ["configuration", "list", "skill", "--json"];
		if (entry === "main") await expect(main(args)).rejects.toBe(exited);
		else expect(await handleConfigCommand(args)).toBe(true);

		const ids = JSON.parse(out.join("\n")) as Array<{ id: string; value: boolean }>;
		// Built-ins have no switch: no extension row exists, whatever the leftover key says.
		expect(ids.map((item) => item.id).filter((id) => id.startsWith("extension:"))).toEqual([]);
	});

	it("uses the caller's built-in factory once", async () => {
		const replacement = vi.fn();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({}),
			nativeFeatures: nativeFeatureSet(),
			builtinFeatures: [{ id: "mcp", owner: "builtin", register: replacement }],
		});
		await loader.reload();
		expect(loader.getFeatures().errors).toEqual([]);
		expect(loader.getFeatures().features.map((feature) => feature.path)).toEqual(["builtin:mcp", "<inline:octocode>"]);
		expect(replacement).toHaveBeenCalledTimes(1);
	});

	it("loads inline factories in order without native defaults", async () => {
		const calls: string[] = [];
		const factories: TestFeatureInput[] = [
			() => {
				calls.push("first");
			},
			(api) => {
				api.tools.register({
					name: "probe",
					label: "Probe",
					description: "Test tool.",
					parameters: Type.Object({}),
					defaultActive: false,
					execute: async () => ({ content: [], details: {} }),
				});
			},
			() => {
				calls.push("last");
			},
		];
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			features: testFeatures(factories),
			settingsManager: SettingsManager.inMemory({}),
		});
		await loader.reload();
		const { features, errors } = loader.getFeatures();
		expect(errors).toEqual([]);
		expect(calls).toEqual(["first", "last"]);
		expect(features.some((feature) => feature.path.startsWith("builtin:"))).toBe(false);
		const tools = features.flatMap((feature) => [...feature.tools.values()]);
		expect(tools).toHaveLength(1);
		expect(tools[0]?.definition.name).toBe("probe");
		expect(tools[0]?.definition.defaultActive).toBe(false);
	});
});
