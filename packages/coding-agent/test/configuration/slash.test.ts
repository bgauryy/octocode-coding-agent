import "../../src/octocode/mcp-host/core-install.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS, getBuiltinCommand } from "../../src/core/slash-commands.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { setupEditorSubmitHandler } from "../../src/modes/interactive/interactive-mode/command-dispatch.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { createFakeHost } from "../interactive-mode-host.ts";
import { type Sandbox, createSandbox } from "../discovery/fixtures.ts";
import { globalSettingsFile, readJson } from "./helpers.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
	initTheme("dark", false);
});
afterEach(() => sandbox.cleanup());

function mode() {
	const printed: string[] = [];
	const instance: any = {
		defaultEditor: {},
		editor: { setText: vi.fn() },
		showError: vi.fn(),
		showWarning: vi.fn(),
		showSelector: vi.fn(),
		chatContainer: {
			addChild: (child: { render(width: number): string[] }) => printed.push(child.render(200).join("\n")),
		},
		ui: { requestRender: vi.fn() },
		settingsManager: SettingsManager.create(sandbox.cwd, sandbox.agentDir, { projectTrusted: false }),
		sessionManager: { getCwd: () => sandbox.cwd },
		session: {
			resourceLoader: {},
			getAllTools: () => [{ name: "timer" }],
			extensionRunner: { getRegisteredCommands: () => [], hasHandlers: () => false },
		},
	};
	setupEditorSubmitHandler(createFakeHost(instance));
	return { instance, printed };
}

describe("/configuration", () => {
	it("is the one built-in for configuration; /settings and /config are aliases that open it", async () => {
		expect(getBuiltinCommand("configuration")?.argumentHint).toContain("enable");
		expect(getBuiltinCommand("settings")).toBeUndefined();
		expect(getBuiltinCommand("config")).toBeUndefined();
		const { instance } = mode();
		instance.getSlashCommands = () => BUILTIN_SLASH_COMMANDS;
		await instance.defaultEditor.onSubmit("/settings");
		await instance.defaultEditor.onSubmit("/config");
		expect(instance.showWarning).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(instance.showSelector).toHaveBeenCalledTimes(2));
	});

	it("opens the selector without arguments", async () => {
		const { instance } = mode();
		await instance.defaultEditor.onSubmit("/configuration");
		await vi.waitFor(() => expect(instance.showSelector).toHaveBeenCalledTimes(1));
	});

	it("runs text verbs and prints each result with when it applies", async () => {
		const { instance, printed } = mode();
		await instance.defaultEditor.onSubmit("/configuration disable tool:backlog");
		expect(printed.join("\n")).toContain("applies in the next session");
		expect(readJson(globalSettingsFile(sandbox))?.defaultTools).toEqual(["-backlog"]);
		await instance.defaultEditor.onSubmit("/configuration get tool:backlog");
		expect(printed.at(-1)).toContain("value: off");
		await instance.defaultEditor.onSubmit("/configuration enable tool:backlg");
		expect(printed.at(-1)).toContain("Did you mean: tool:backlog");
		await instance.defaultEditor.onSubmit("/configuration disable tool:timer --local");
		expect(printed.at(-1)).toContain("not trusted");
		expect(instance.showError).not.toHaveBeenCalled();
	});
});
