import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import type { TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const examplesDir = join(import.meta.dirname, "../examples/extensions");

describe("tool renderer examples", () => {
	let tempDir: string;
	let agentDir: string;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tool-renderer-example-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function getSessionState(extensionPath: string | undefined, tools: string[]) {
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			nativeFeatures: false,
			cwd: tempDir,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: extensionPath ? [extensionPath] : [],
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getBuiltinModel("anthropic", "claude-sonnet-4-5"),
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
			tools,
		});
		try {
			return {
				systemPrompt: session.systemPrompt,
				bashToolDefinition: session.getToolDefinition("bash"),
			};
		} finally {
			session.dispose();
		}
	}

	it.each([
		{
			name: "built-in tool renderer",
			extensionPath: join(examplesDir, "built-in-tool-renderer.ts"),
			tools: ["bash"],
		},
		{
			name: "minimal mode",
			extensionPath: join(examplesDir, "minimal-mode.ts"),
			tools: ["bash"],
		},
	])("keeps the system prompt unchanged for the $name example", async ({ extensionPath, tools }) => {
		const baseline = await getSessionState(undefined, tools);
		const withRenderer = await getSessionState(extensionPath, tools);

		expect(withRenderer.systemPrompt).toBe(baseline.systemPrompt);
	});

	it("keeps minimal mode's bash tool in the default shell", async () => {
		const minimalMode = await getSessionState(join(examplesDir, "minimal-mode.ts"), ["bash"]);
		const bashToolDefinition = minimalMode.bashToolDefinition;
		if (!bashToolDefinition) throw new Error("minimal mode did not register the bash tool");
		const { renderShell: _renderShell, ...defaultShellDefinition } = bashToolDefinition;

		expect(renderBashTool(bashToolDefinition, tempDir)).toEqual(renderBashTool(defaultShellDefinition, tempDir));
	});
});

function renderBashTool(definition: ToolDefinition, cwd: string): string[] {
	const component = new ToolExecutionComponent(
		"bash",
		"bash-shell-test",
		{ command: "echo after" },
		{},
		definition,
		{ requestRender() {} } as unknown as TUI,
		cwd,
	);
	return component.render(40);
}
