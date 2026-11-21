import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createTestSession } from "./helpers/session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBashTool, createBashToolDefinition } from "../src/core/tools/index.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { testFeatures } from "./helpers/features.ts";

const strictToolNames = ["bash"] as const;
const definitionFor = (cwd: string) => ({ bash: createBashToolDefinition(cwd) });

describe("strict built-in tools", () => {
	afterEach(() => vi.unstubAllEnvs());

	it.each([undefined, "0", "1"])("prefers strict sampling with OCTOCODE_EXPERIMENTAL=%s", (experimental) => {
		vi.stubEnv("OCTOCODE_EXPERIMENTAL", experimental);
		const definitions = definitionFor(process.cwd());
		const tools = { bash: createBashTool(process.cwd()) };
		for (const name of strictToolNames) {
			expect(definitions[name].constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
			expect(tools[name].constrainedSampling).toEqual(definitions[name].constrainedSampling);
		}
		// Strictness is a provider-side conversion, not a change to the execution schema.
		expect(definitions.bash.parameters.required).toEqual(["command"]);
	});

	it("preserves explicit opt-outs when wrapping definitions for execution", () => {
		const definitions = definitionFor(process.cwd());
		for (const name of strictToolNames) {
			const definition = definitions[name];
			const override = { ...definition, constrainedSampling: false as const };
			expect(wrapToolDefinition(override as never).constrainedSampling).toBe(false);
			expect(override.execute).toBe(definition.execute);
			expect(override.prepareArguments).toBe(definition.prepareArguments);
			expect(override.renderCall).toBe(definition.renderCall);
			expect(override.renderResult).toBe(definition.renderResult);
			expect(override.promptGuidelines).toBe(definition.promptGuidelines);
			expect(definition.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
		}
	});

	it.each([{ activeTools: [] }, { activeTools: [...strictToolNames] }])(
		"allows extensions to re-register tools without strict sampling: $activeTools",
		async ({ activeTools }) => {
			const cwd = mkdtempSync(join(tmpdir(), "octocode-non-strict-tools-"));
			const agentDir = join(cwd, "agent");
			const settingsManager = SettingsManager.inMemory({ defaultTools: activeTools });
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				disabledFeatures: ["mcp"],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				features: testFeatures([
					(api) => {
						api.bus.on("session_start", () => {
							const definitions = definitionFor(cwd);
							for (const name of strictToolNames) {
								api.tools.register({ ...definitions[name], constrainedSampling: false } as never);
							}
							api.tools.setActive(activeTools);
						});
					},
				]),
			});
			try {
				await resourceLoader.reload();
				const { session } = await createTestSession({
					cwd,
					agentDir,
					model: getBuiltinModel("anthropic", "claude-sonnet-4-5"),
					settingsManager,
					sessionManager: SessionManager.inMemory(cwd),
					resourceLoader,
				});
				try {
					const originalPrompt = session.systemPrompt;
					await session.bindFeatures({});
					expect(session.getActiveToolNames()).toEqual(activeTools);
					expect(session.systemPrompt).toBe(originalPrompt);
					for (const name of strictToolNames) {
						expect(session.getToolDefinition(name)?.constrainedSampling).toBe(false);
					}
					for (const tool of session.agent.state.tools) {
						expect(tool.constrainedSampling).toBe(false);
					}
					if (activeTools.includes("bash")) {
						const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
						const result = await bash.execute("bash-test", { command: "echo still works" });
						expect(result.content).toEqual([
							{ type: "text", text: expect.stringMatching(/^\[exit 0 · [\d.]+s\]\nstill works\n?$/) },
						]);
					}
				} finally {
					session.dispose();
				}
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	);
});
