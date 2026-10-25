import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectConfig } from "../src/cli/config-selector.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { InlineExtension } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createToolSearchExtension } from "../src/core/tools/tool-search.ts";
import { main } from "../src/main.ts";
import { handleConfigCommand } from "../src/package-manager-cli/config-command.ts";

vi.mock("../src/cli/config-selector.ts", () => ({ selectConfig: vi.fn() }));

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

	it.each(["main", "config"])("shows default built-ins through %s without injected factories", async (entry) => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }));
		const args = ["config", "--no-approve"];
		await expect(entry === "main" ? main(args) : handleConfigCommand(args)).rejects.toBe(exited);

		const options = vi.mocked(selectConfig).mock.calls[0]?.[0];
		expect(options).toBeDefined();
		for (const scope of ["global", "project"] as const) {
			const builtins = options.resolvedPaths[scope].extensions.filter((item) => item.path.startsWith("builtin:"));
			expect(builtins.map((item) => item.path).sort()).toEqual([
				"builtin:llama.cpp",
				"builtin:mcp",
				"builtin:tool-search",
			]);
			expect(builtins.find((item) => item.path === "builtin:mcp")?.enabled).toBe(false);
		}
	});

	it("shows caller built-ins once alongside defaults", async () => {
		const factory = vi.fn();
		await expect(
			handleConfigCommand(["config", "--no-approve"], {
				extensionFactories: [
					{ name: "mcp", builtin: true, factory },
					{ name: "custom", builtin: true, factory },
				],
			}),
		).rejects.toBe(exited);
		const paths = vi.mocked(selectConfig).mock.calls[0][0].resolvedPaths.global.extensions.map((item) => item.path);
		expect(paths.filter((path) => path === "builtin:mcp")).toHaveLength(1);
		expect(paths).toContain("builtin:custom");
		expect(factory).not.toHaveBeenCalled();
	});

	it("uses the caller's built-in factory once and respects disabled defaults", async () => {
		const replacement = vi.fn();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({ extensions: ["-builtin:llama.cpp", "-builtin:tool-search"] }),
			extensionFactories: [{ name: "mcp", builtin: true, factory: replacement }],
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
			"builtin:mcp",
			"<inline:octocode>",
		]);
		expect(replacement).toHaveBeenCalledTimes(1);
	});

	it("allows explicit discovery without native defaults and preserves inline factory order", async () => {
		const calls: string[] = [];
		const extensionFactories: InlineExtension[] = [
			() => {
				calls.push("first");
			},
			createToolSearchExtension(),
			() => {
				calls.push("last");
			},
		];
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			nativeFeatures: false,
			extensionFactories,
			settingsManager: SettingsManager.inMemory({}),
		});
		await loader.reload();
		const { extensions, errors } = loader.getExtensions();
		expect(errors).toEqual([]);
		expect(calls).toEqual(["first", "last"]);
		expect(extensions.some((extension) => extension.path.startsWith("builtin:"))).toBe(false);
		const discovery = extensions.flatMap((extension) => [...extension.tools.values()]);
		expect(discovery).toHaveLength(1);
		expect(discovery[0]?.definition.name).toBe("tool_search");
		expect(discovery[0]?.definition.defaultActive).toBe(false);
	});
});
