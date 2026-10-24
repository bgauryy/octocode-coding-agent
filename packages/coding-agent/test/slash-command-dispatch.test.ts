import { beforeAll, describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS, getBuiltinCommand, parseSlashCommand } from "../src/core/slash-commands.ts";
import { CommandSelectorComponent } from "../src/modes/interactive/components/command-selector.ts";
import { getSlashCommands } from "../src/modes/interactive/interactive-mode/autocomplete.ts";
import { setupEditorSubmitHandler } from "../src/modes/interactive/interactive-mode/command-dispatch.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";
import { NATIVE_FEATURE_PATH } from "../src/core/native-tools.ts";

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

describe("built-in slash commands", () => {
	it.each(BUILTIN_SLASH_COMMANDS.flatMap((command) => (command.aliases ?? []).map((alias) => ({ alias, command }))))(
		"dispatches /$alias with the same arguments and effects as its canonical command",
		async ({ alias, command }) => {
			const instance = mode();
			const effects: unknown[][] = [];
			for (const method of [
				"handleClearCommand",
				"shutdown",
				"showSettingsSelector",
				"handleChangelogCommand",
				"handleBugCommand",
				"handleSessionCommand",
				"handleLoginCommand",
				"handleModelCommand",
				"handleThinkingCommand",
			])
				instance[method] = (...args: unknown[]) => effects.push([method, ...args]);
			instance.session.extensionRunner.getRegisteredCommands = () =>
				["resume", "status", "permissions", "agents"].map((name) => ({
					name,
					sourceInfo: { path: NATIVE_FEATURE_PATH },
					handler: (args: string) => effects.push([name, args]),
				}));
			const args = command.argumentHint ? " preserved  argument" : "";
			await instance.defaultEditor.onSubmit(`/${command.name}${args}`);
			const expected = structuredClone(effects);
			expect(expected.length).toBeGreaterThan(0);
			effects.length = 0;
			await instance.defaultEditor.onSubmit(`/${alias}${args}`);
			expect(effects).toEqual(expected);
			expect(instance.showError).not.toHaveBeenCalled();
			expect(instance.showWarning).not.toHaveBeenCalled();
		},
	);

	it("resolves canonical names and their declared aliases", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(new Set(names).size).toBe(names.length);
		for (const command of BUILTIN_SLASH_COMMANDS) {
			expect(command.name).toMatch(/^[a-z]+$/);
			expect(getBuiltinCommand(command.name)).toBe(command);
			for (const alias of command.aliases ?? []) expect(getBuiltinCommand(alias)).toBe(command);
		}
		for (const name of ["qui", "Settings", "sessions"]) expect(getBuiltinCommand(name)).toBeUndefined();
	});

	it("routes aliases through canonical handlers and refuses unavailable native commands", async () => {
		const instance = mode();
		instance.handleClearCommand = vi.fn();
		instance.shutdown = vi.fn();
		instance.showSettingsSelector = vi.fn();
		await instance.defaultEditor.onSubmit("/clear Release plan");
		await instance.defaultEditor.onSubmit("/reset");
		expect(instance.handleClearCommand.mock.calls).toEqual([["Release plan"], [undefined]]);
		await instance.defaultEditor.onSubmit("/exit");
		expect(instance.shutdown).toHaveBeenCalledOnce();
		await instance.defaultEditor.onSubmit("/config");
		expect(instance.showSettingsSelector).toHaveBeenCalledOnce();
		await instance.defaultEditor.onSubmit("/peers");
		expect(instance.showWarning).toHaveBeenCalledWith("/agents requires native features.");
	});

	it("forwards values intact through whitespace separators", async () => {
		const instance = mode();
		instance.handleNameCommand = vi.fn();
		instance.handleThinkingCommand = vi.fn();
		instance.handleBugCommand = vi.fn();
		await instance.defaultEditor.onSubmit("/rename\tRelease  notes");
		await instance.defaultEditor.onSubmit("/effort high");
		await instance.defaultEditor.onSubmit("/bug The screen  flickers");
		expect(instance.handleNameCommand).toHaveBeenCalledWith("/name Release  notes");
		expect(instance.handleThinkingCommand).toHaveBeenCalledWith("high");
		expect(instance.handleBugCommand).toHaveBeenCalledWith("The screen  flickers");
		expect(instance.showError).not.toHaveBeenCalled();
	});

	it("passes the /github action to its handler", async () => {
		const instance = mode();
		instance.handleGithubCommand = vi.fn();
		await instance.defaultEditor.onSubmit("/github");
		await instance.defaultEditor.onSubmit("/github login");
		expect(instance.handleGithubCommand.mock.calls).toEqual([[""], ["login"]]);
		expect(getBuiltinCommand("github")?.argumentValues).toEqual(["status", "login", "logout"]);
	});

	it("quits through the cleanup path, but refuses unexpected arguments", async () => {
		const instance = mode();
		instance.shutdown = vi.fn();
		await instance.defaultEditor.onSubmit("/quit");
		await instance.defaultEditor.onSubmit("/quit");
		await instance.defaultEditor.onSubmit("/quit later");
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

	it("passes custom summary focus to the canonical compaction handler", async () => {
		const instance = mode();
		instance.handleCompactCommand = vi.fn();
		await instance.defaultEditor.onSubmit("/compact preserve the release plan");
		expect(instance.handleCompactCommand).toHaveBeenCalledWith("preserve the release plan");
		expect(instance.showWarning).not.toHaveBeenCalled();
		await instance.defaultEditor.onSubmit("/compact");
		expect(instance.handleCompactCommand).toHaveBeenCalledTimes(2);
	});

	it("preserves session cancellation and distinguishes cloning from forking", async () => {
		const instance = mode();
		instance.handleClearCommand = vi.fn(async () => ({ cancelled: true }));
		instance.handleCloneCommand = vi.fn();
		instance.showUserMessageSelector = vi.fn();
		await instance.defaultEditor.onSubmit("/new");
		await instance.defaultEditor.onSubmit("/fork");
		await instance.defaultEditor.onSubmit("/clone");
		expect(instance.handleClearCommand).toHaveBeenCalledOnce();
		expect(instance.handleCloneCommand).toHaveBeenCalledOnce();
		expect(instance.showUserMessageSelector).toHaveBeenCalledOnce();
	});

	it("combines native status with statistics and routes the session browser to the native owner", async () => {
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
		await instance.defaultEditor.onSubmit("/status");
		await instance.defaultEditor.onSubmit("/resume project");
		await instance.defaultEditor.onSubmit("/resume all");
		expect(instance.handleSessionCommand).toHaveBeenCalledOnce();
		expect(status).toHaveBeenCalledOnce();
		expect(resume).toHaveBeenNthCalledWith(1, "project", context);
		expect(resume).toHaveBeenNthCalledWith(2, "all", context);
		expect(foreign).not.toHaveBeenCalled();
		expect(instance.showSessionSelector).not.toHaveBeenCalled();
	});

	it("falls back to core resume when native features are disabled", async () => {
		const instance = mode();
		instance.showSessionSelector = vi.fn();
		await instance.defaultEditor.onSubmit("/resume");
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
			.mockResolvedValueOnce("Model shortcuts — choose models for keyboard cycling")
			.mockResolvedValueOnce("Model catalog — prices, capabilities and agent routing");
		const catalog = vi.fn();
		instance.session.extensionRunner.getRegisteredCommands = () => [
			{ name: "modelsettings", sourceInfo: { path: "<inline:octocode>" }, handler: catalog },
		];
		instance.session.extensionRunner.getCommand = () => undefined;
		await instance.defaultEditor.onSubmit("/modelsettings");
		await instance.defaultEditor.onSubmit("/modelsettings");
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
	it("finds a command by its description and inserts it without executing it", () => {
		const choose = vi.fn();
		const picker = new CommandSelectorComponent("Commands", BUILTIN_SLASH_COMMANDS, choose, vi.fn(), "Report a bug");
		expect(picker.render(120).join("\n")).toContain("/bug");
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
