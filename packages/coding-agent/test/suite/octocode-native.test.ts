import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@octocodeai/octocode-ai";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getApiProvider,
	registerApiProvider,
} from "@octocodeai/octocode-ai/compat";
import { expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { createHarness, getAssistantTexts, getToolResult, type Harness } from "./harness.ts";

it("runs native tools and releases team resources across a real session reload", async () => {
	const root = mkdtempSync(join(tmpdir(), "octocode-lifecycle-"));
	const events: string[] = [];
	const errors: string[] = [];
	const prompts: string[] = [];
	let harness: Harness | undefined;
	let store: TeamStore | undefined;
	let stopped = false;
	for (const [name, value] of Object.entries({
		HOME: root,
		USERPROFILE: root,
		OCTOCODE_HOME: join(root, ".octocode"),
		OCTOCODE_CODING_AGENT_DIR: join(root, ".octocode", "agent"),
		OCTOCODE_MCP: "0",
		OCTOCODE_API: "0",
		OCTOCODE_MODELS_DEV: "0",
		OCTOCODE_EXTRA_SKILLS: "0",
		OCTOCODE_MEMORY_AUTO: "0",
		OCTOCODE_NOTIFY: "off",
		OCTOCODE_PERMISSION: "full",
	}))
		vi.stubEnv(name, value);
	try {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, ".octocode", "agent"),
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				(api) => {
					api.on("session_start", async (event) => {
						events.push(`start:${event.reason}`);
					});
					api.on("session_shutdown", async (event) => {
						events.push(`stop:${event.reason}`);
						expect(store?.list() ?? []).toEqual([]);
						expect(store?.leases() ?? []).toEqual([]);
					});
				},
			],
		});
		await loader.reload();
		harness = await createHarness({ resourceLoader: loader });
		const fauxApi = getApiProvider(harness.faux.api);
		if (!fauxApi) throw new Error("Missing faux API");
		await harness.session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error) });
		expect(events).toEqual(["start:startup"]);
		store = TeamStore.open(harness.tempDir);
		for (let run = 0; run < 2; run++) {
			const native = loader.getExtensions().extensions.filter((entry) => entry.path === "<inline:octocode>");
			expect(native).toHaveLength(1);
			const names = harness.session.getAllTools().map((tool) => tool.name);
			expect(new Set(names).size).toBe(names.length);
			expect(names).toEqual(expect.arrayContaining(["file", "agent", "bash"]));
			for (const name of ["edit", "write", "grep", "find", "ls"]) expect(names).not.toContain(name);
			for (const tool of harness.session
				.getAllTools()
				.filter((tool) => ["file", "bash", "agent"].includes(tool.name))) {
				expect(tool.sourceInfo.source).toBe("builtin");
			}
			harness.session.setActiveToolsByName(["bash", "file", "agent"]);
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("agent", {
						type: "coordinate",
						input: { action: "join", goal: "Verify native lifecycle" },
						reason: "Register this session in the team",
					}),
					{
						stopReason: "toolUse",
					},
				),
				fauxAssistantMessage(
					fauxToolCall("agent", {
						type: "coordinate",
						input: { action: "lock", paths: [`run-${run}.txt`] },
						reason: "Reserve the file before editing",
					}),
					{
						stopReason: "toolUse",
					},
				),
				fauxAssistantMessage(
					fauxToolCall("file", {
						queries: [
							{
								type: "write",
								path: `run-${run}.txt`,
								content: `run ${run}`,
								reason: "Test native execution",
							},
						],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall("bash", { command: `cat run-${run}.txt`, reason: "Read the new file before editing" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall("file", {
						queries: [
							{
								type: "edit",
								path: `run-${run}.txt`,
								edits: [{ oldText: `run ${run}`, newText: `updated ${run}` }],
								reason: "Verify core file editing",
							},
						],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall("bash", {
						command: `grep -q "updated ${run}" run-${run}.txt`,
						verify: true,
						reason: "Verify the edit",
					}),
					{ stopReason: "toolUse" },
				),
				(context) => {
					prompts.push(getCurrentSystemPrompt(context.messages));
					return fauxAssistantMessage(`completed ${run}`);
				},
			]);
			await harness.session.prompt(`Write run-${run}.txt and retain its reservation.`);
			expect(getAssistantTexts(harness).at(-1)).toBe(`completed ${run}`);
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(prompts.at(-1)).toContain("# Delegation");
			expect(getToolResult(harness, "file").isError).not.toBe(true);
			expect(readFileSync(join(harness.tempDir, `run-${run}.txt`), "utf8")).toBe(`updated ${run}`);
			expect(store.list()).toHaveLength(1);
			expect(store.leases()).toHaveLength(1);
			if (run === 0) {
				await harness.session.reload();
				// Reload resets the compatibility registry, including the harness's synthetic provider.
				registerApiProvider(fauxApi);
				expect(events).toEqual(["start:startup", "stop:reload", "start:reload"]);
				expect(store.list()).toEqual([]);
				expect(store.leases()).toEqual([]);
			}
		}
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		stopped = true;
		expect(events).toEqual(["start:startup", "stop:reload", "start:reload", "stop:quit"]);
		expect(errors).toEqual([]);
	} finally {
		if (!stopped) await harness?.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		store?.close();
		harness?.cleanup();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});
