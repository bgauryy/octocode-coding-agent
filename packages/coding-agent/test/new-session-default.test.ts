import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createCliRuntimeFactory } from "../src/main/runtime-factory.ts";
import { nativeFeatureSet } from "./helpers/native-features.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function open(flags: string[] = []) {
	const root = mkdtempSync(join(tmpdir(), "octocode-new-default-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	vi.stubEnv("HOME", root);
	vi.stubEnv("USERPROFILE", root);
	vi.stubEnv("OCTOCODE_HOME", agentDir);
	const network = vi.fn(() => Promise.reject(new Error("Unexpected network request")));
	vi.stubGlobal("fetch", network);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"default-fixture": {
					baseUrl: "http://127.0.0.1:1/v1",
					api: "openai-completions",
					apiKey: "fixture",
					models: ["model-a", "model-b"].map((id) => ({
						id,
						name: id,
						reasoning: false,
						input: ["text"],
						contextWindow: 32768,
						maxTokens: 4096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					})),
				},
			},
		}),
	);
	const parsed = parseArgs([
		"--no-tools",
		"--no-mcp",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		...flags,
	]);
	expect(parsed.diagnostics).toEqual([]);
	const runtime = await createAgentSessionRuntime(
		createCliRuntimeFactory({
			parsed,
			cwd,
			nativeFeatures: nativeFeatureSet(),
			folderTrust: () => ({ state: "trusted", root: cwd }),
			requireTrust: true,
			getAppMode: () => "interactive",
			skillResourceSnapshot: undefined,
		}),
		{ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
	);
	cleanups.push(() => runtime.dispose());
	return { runtime, agentDir, network };
}

describe("the default model used by /new", () => {
	it("reloads the saved default instead of retaining a session-only selection", async () => {
		const { runtime, agentDir, network } = await open();
		const modelA = runtime.session.modelRuntime.getModel("default-fixture", "model-a")!;
		const modelB = runtime.session.modelRuntime.getModel("default-fixture", "model-b")!;
		await runtime.session.setModel(modelA, { persist: true });
		await runtime.session.setModel(modelB, { persist: false });
		expect(runtime.session.model?.id).toBe("model-b");
		const previousSettings = runtime.session.settingsManager;
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).defaultModel).toBe("model-a");
		await expect(runtime.newSession()).resolves.toEqual({ cancelled: false });
		expect(runtime.session.settingsManager).not.toBe(previousSettings);
		expect(runtime.session.model).toMatchObject({ provider: "default-fixture", id: "model-a" });
		expect(network).not.toHaveBeenCalled();
	});

	it.each([
		{ name: "an explicit --model", flags: ["--model", "default-fixture/model-b"] },
		{
			name: "a run-scoped default",
			flags: ["--set", "defaultProvider=default-fixture", "--set", "defaultModel=model-b"],
		},
	])("keeps $name ahead of the saved global default after /new", async ({ flags }) => {
		const { runtime, agentDir, network } = await open(flags);
		const modelA = runtime.session.modelRuntime.getModel("default-fixture", "model-a")!;
		await runtime.session.setModel(modelA, { persist: true });
		expect(runtime.session.model?.id).toBe("model-a");
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).defaultModel).toBe("model-a");
		await runtime.newSession();
		expect(runtime.session.model).toMatchObject({ provider: "default-fixture", id: "model-b" });
		expect(network).not.toHaveBeenCalled();
	});
});
