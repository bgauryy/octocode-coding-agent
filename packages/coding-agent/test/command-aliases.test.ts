import { beforeAll, describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS, getBuiltinCommand, parseSlashCommand } from "../src/core/slash-commands.ts";
import { CommandSelectorComponent } from "../src/modes/interactive/components/command-selector.ts";
import { getSlashCommands } from "../src/modes/interactive/interactive-mode/autocomplete.ts";
import { setupEditorSubmitHandler } from "../src/modes/interactive/interactive-mode/command-dispatch.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

function mode() {
	const instance: any = {};
	Object.assign(instance, {
		defaultEditor: {},
		editor: { setText: vi.fn() },
		showError: vi.fn(),
		showWarning: vi.fn(),
		session: { extensionRunner: { getRegisteredCommands: () => [], createCommandContext: () => ({}) } },
	});
	setupEditorSubmitHandler(createFakeHost(instance));
	return instance;
}

describe("one-word command aliases", () => {
	it("resolves exact aliases and keeps builtin names unique", () => {
		const names = BUILTIN_SLASH_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
		expect(new Set(names).size).toBe(names.length);
		for (const command of BUILTIN_SLASH_COMMANDS) {
			expect(command.name).toMatch(/^[a-z]+$/);
			for (const alias of command.aliases ?? []) expect(getBuiltinCommand(alias)).toBe(command);
		}
		expect(getBuiltinCommand("qui")).toBeUndefined();
		expect(getBuiltinCommand("Config")).toBeUndefined();
	});

	it("forwards values intact through aliases and whitespace separators", async () => {
		const instance = mode();
		instance.handleNameCommand = vi.fn();
		instance.handleThinkingCommand = vi.fn();
		instance.handleBugCommand = vi.fn();
		await instance.defaultEditor.onSubmit("/rename\tRelease  notes");
		await instance.defaultEditor.onSubmit("/reasoning high");
		await instance.defaultEditor.onSubmit("/feedback The screen  flickers");
		expect(instance.handleNameCommand).toHaveBeenCalledWith("/name Release  notes");
		expect(instance.handleThinkingCommand).toHaveBeenCalledWith("high");
		expect(instance.handleBugCommand).toHaveBeenCalledWith("The screen  flickers");
		expect(instance.showError).not.toHaveBeenCalled();
	});

	it("uses the same cleanup path for exit and quit, but refuses unexpected arguments", async () => {
		const instance = mode();
		instance.shutdown = vi.fn();
		await instance.defaultEditor.onSubmit("/exit");
		await instance.defaultEditor.onSubmit("/quit");
		await instance.defaultEditor.onSubmit("/exit later");
		expect(instance.shutdown).toHaveBeenCalledTimes(2);
		expect(instance.showWarning).toHaveBeenCalledWith("/quit does not take arguments.");
	});

	it("preserves file path arguments when importing and exporting sessions", async () => {
		const instance = mode();
		instance.handleExportCommand = vi.fn();
		instance.handleImportCommand = vi.fn();
		await instance.defaultEditor.onSubmit('/export "release notes.jsonl"');
		await instance.defaultEditor.onSubmit("/import /tmp/saved-session.jsonl");
		expect(instance.handleExportCommand).toHaveBeenCalledWith('/export "release notes.jsonl"');
		expect(instance.handleImportCommand).toHaveBeenCalledWith("/import /tmp/saved-session.jsonl");
		expect(instance.showWarning).not.toHaveBeenCalled();
		expect(instance.showError).not.toHaveBeenCalled();
	});

	it("rejects unsupported compaction arguments instead of silently dropping them", async () => {
		const instance = mode();
		instance.handleCompactCommand = vi.fn();
		await instance.defaultEditor.onSubmit("/compact preserve the release plan");
		expect(instance.handleCompactCommand).not.toHaveBeenCalled();
		expect(instance.showWarning).toHaveBeenCalledWith("/compact does not take arguments.");
		await instance.defaultEditor.onSubmit("/compact");
		expect(instance.handleCompactCommand).toHaveBeenCalledOnce();
	});

	it("preserves session cancellation and distinguishes cloning from forking", async () => {
		const instance = mode();
		instance.handleClearCommand = vi.fn(async () => ({ cancelled: true }));
		instance.handleCloneCommand = vi.fn();
		instance.showUserMessageSelector = vi.fn();
		await instance.defaultEditor.onSubmit("/clear");
		await instance.defaultEditor.onSubmit("/fork");
		await instance.defaultEditor.onSubmit("/clone");
		expect(instance.handleClearCommand).toHaveBeenCalledOnce();
		expect(instance.handleCloneCommand).toHaveBeenCalledOnce();
		expect(instance.showUserMessageSelector).toHaveBeenCalledOnce();
	});

	it("combines native status with statistics and routes both session browser names to the native owner", async () => {
		const instance = mode();
		instance.handleSessionCommand = vi.fn();
		instance.showSessionSelector = vi.fn();
		const status = vi.fn();
		const resume = vi.fn();
		const foreign = vi.fn();
		const context = {};
		instance.session.extensionRunner = {
			createCommandContext: () => context,
			getRegisteredCommands: () => [
				{ name: "status", sourceInfo: { path: "/foreign.ts" }, handler: foreign },
				{ name: "status", sourceInfo: { path: "<inline:octocode>" }, handler: status },
				{ name: "resume", sourceInfo: { path: "<inline:octocode>" }, handler: resume },
			],
		};
		for (const command of ["status", "info", "session"]) await instance.defaultEditor.onSubmit(`/${command}`);
		await instance.defaultEditor.onSubmit("/resume project");
		await instance.defaultEditor.onSubmit("/sessions all");
		expect(instance.handleSessionCommand).toHaveBeenCalledTimes(3);
		expect(status).toHaveBeenCalledTimes(3);
		expect(resume).toHaveBeenNthCalledWith(1, "project", context);
		expect(resume).toHaveBeenNthCalledWith(2, "all", context);
		expect(foreign).not.toHaveBeenCalled();
		expect(instance.showSessionSelector).not.toHaveBeenCalled();
	});

	it("falls back to core resume when native features are disabled", async () => {
		const instance = mode();
		instance.showSessionSelector = vi.fn();
		await instance.defaultEditor.onSubmit("/sessions");
		expect(instance.showSessionSelector).toHaveBeenCalledOnce();
	});

	it("keeps both trust scopes accessible and cancellation does not change either", async () => {
		const instance = mode();
		instance.showTrustSelector = vi.fn();
		instance.showExtensionSelector = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce("Project resources")
			.mockResolvedValueOnce("Native project configuration");
		const trust = vi.fn();
		instance.session.extensionRunner.getRegisteredCommands = () => [
			{ name: "trust", sourceInfo: { path: "<inline:octocode>" }, handler: trust },
		];
		await instance.defaultEditor.onSubmit("/trust");
		expect(trust).not.toHaveBeenCalled();
		expect(instance.showTrustSelector).not.toHaveBeenCalled();
		await instance.defaultEditor.onSubmit("/trust");
		await instance.defaultEditor.onSubmit("/trust");
		await instance.defaultEditor.onSubmit("/trust off");
		expect(instance.showTrustSelector).toHaveBeenCalledOnce();
		expect(trust.mock.calls.map(([args]) => args)).toEqual(["", "off"]);
	});

	it("keeps model cycling and the catalog reachable from the same manager", async () => {
		const instance = mode();
		instance.showModelsSelector = vi.fn();
		instance.showExtensionSelector = vi
			.fn()
			.mockResolvedValueOnce("Model cycling")
			.mockResolvedValueOnce("Catalog and agent routing");
		const catalog = vi.fn();
		instance.session.extensionRunner.getRegisteredCommands = () => [
			{ name: "models", sourceInfo: { path: "<inline:octocode>" }, handler: catalog },
		];
		instance.session.extensionRunner.getCommand = () => undefined;
		await instance.defaultEditor.onSubmit("/scoped-models");
		await instance.defaultEditor.onSubmit("/models");
		expect(instance.showModelsSelector).toHaveBeenCalledOnce();
		expect(catalog).toHaveBeenCalledOnce();
	});

	it("parses only slash commands without treating paths or prefixes as known actions", () => {
		expect(parseSlashCommand("hello /exit")).toBeUndefined();
		expect(parseSlashCommand("/tmp/file")).toEqual({ name: "tmp/file", args: "" });
		expect(getBuiltinCommand(parseSlashCommand("/tmp/file")!.name)).toBeUndefined();
	});
});

describe("command picker", () => {
	beforeAll(() => initTheme("dark"));
	it("finds an alias and inserts its canonical command without executing it", () => {
		const choose = vi.fn();
		const picker = new CommandSelectorComponent("Commands", BUILTIN_SLASH_COMMANDS, choose, vi.fn(), "feedback");
		expect(picker.render(120).join("\n")).toContain("/bug");
		expect(picker.render(120).join("\n")).toContain("/feedback");
		expect(choose).not.toHaveBeenCalled();
		picker.handleInput("\r");
		expect(choose).toHaveBeenCalledWith("bug");
	});
	it("can cancel without choosing any action", () => {
		const choose = vi.fn();
		const cancel = vi.fn();
		const picker = new CommandSelectorComponent("Commands", BUILTIN_SLASH_COMMANDS, choose, cancel);
		picker.handleInput("\x1b");
		expect(cancel).toHaveBeenCalledOnce();
		expect(choose).not.toHaveBeenCalled();
	});
});

it("keeps native resume hints and built-in trust options visible in the TUI", () => {
	const instance: any = {};
	instance.skillCommands = new Map();
	const complete = vi.fn(() => [{ value: "all", label: "all" }]);
	Object.defineProperty(instance, "session", {
		value: {
			promptTemplates: [],
			extensionRunner: {
				getRegisteredCommands: () => [{ name: "resume", invocationName: "resume", getArgumentCompletions: complete }],
			},
		},
	});
	const commands: any[] = getSlashCommands(createFakeHost(instance), false);
	expect(
		commands
			.find((command: any) => command.name === "trust")
			.getArgumentCompletions("")
			.map((item: any) => item.value),
	).toEqual(["project", "config", "off"]);
	expect(commands.find((command: any) => command.name === "resume").getArgumentCompletions("")).toEqual([
		{ value: "all", label: "all" },
	]);
	expect(commands.find((command: any) => command.name === "import").argumentKind).toBe("path");
});
