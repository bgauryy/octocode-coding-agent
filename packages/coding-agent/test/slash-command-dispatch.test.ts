import { beforeAll, describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS, getBuiltinCommand, parseSlashCommand } from "../src/core/slash-commands.ts";
import { CommandSelectorComponent } from "../src/modes/interactive/components/command-selector.ts";
import { getSlashCommands } from "../src/modes/interactive/interactive-mode/autocomplete.ts";
import { setupEditorSubmitHandler } from "../src/modes/interactive/interactive-mode/command-dispatch.ts";
import { initTheme } from "../src/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const HINT = " Enter again sends it as a message.";

function mode(commands: any[] = []) {
	const instance: any = {};
	const prompts: Array<[string, any]> = [];
	Object.assign(instance, {
		defaultEditor: {},
		editor: { setText: vi.fn(), addToHistory: vi.fn() },
		showError: vi.fn(),
		showWarning: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		prompts,
		session: {
			isStreaming: false,
			async prompt(text: string, options: any) {
				options?.preflightResult?.("started");
				prompts.push([text, options]);
			},
			extensionRunner: {
				getRegisteredCommands: () => commands,
				getCommand: (name: string) => commands.find((command) => command.name === name),
				createCommandContext: () => ({}),
				hasHandlers: () => false,
			},
		},
	});
	setupEditorSubmitHandler(createFakeHost(instance));
	return instance;
}

describe("built-in slash commands", () => {
	it("resolves only canonical names", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(new Set(names).size).toBe(names.length);
		for (const command of BUILTIN_SLASH_COMMANDS) {
			expect(command.name).toMatch(/^[a-z]+$/);
			expect(Object.keys(command)).not.toContain("aliases");
			expect(getBuiltinCommand(command.name)).toBe(command);
		}
		for (const name of ["qui", "Settings", "sessions", "login", "models", "thinking", "exit", "config", "settings"])
			expect(getBuiltinCommand(name)).toBeUndefined();
	});

	it("runs Claude Code aliases as their Octocode command", async () => {
		const instance = mode();
		const effects: string[] = [];
		for (const method of ["shutdown", "handleProvidersCommand"]) instance[method] = () => effects.push(method);
		instance.getSlashCommands = () => BUILTIN_SLASH_COMMANDS;
		for (const alias of ["/exit", "/login"]) await instance.defaultEditor.onSubmit(alias);
		expect(effects).toEqual(["shutdown", "handleProvidersCommand"]);
	});

	it("does not dispatch removed command names and hints at the closest canonical command", async () => {
		const instance = mode();
		const effects: string[] = [];
		for (const method of [
			"handleClearCommand",
			"shutdown",
			"handleProvidersCommand",
			"handleModelCommand",
			"handleThinkingCommand",
			"handleSessionCommand",
		])
			instance[method] = () => effects.push(method);
		instance.onInputCallback = (text: string) => effects.push(`prompt:${text}`);
		instance.getSlashCommands = () => BUILTIN_SLASH_COMMANDS;
		for (const removed of ["/models", "/thinking high", "/stats"]) await instance.defaultEditor.onSubmit(removed);
		expect(effects).toEqual([]);
		expect(instance.showWarning.mock.calls.map(([message]: [string]) => message)).toEqual(
			[
				"Unknown command /models. Did you mean /model?",
				"Unknown command /thinking. Search commands with /help thinking.",
				"Unknown command /stats. Did you mean /status?",
			].map((message) => message + HINT),
		);
		expect(instance.editor.setText).toHaveBeenLastCalledWith("/stats");
	});

	it("points retired names, typos and topic words at the owning command, and never at an unrelated short one", async () => {
		const instance = mode();
		const effects: string[] = [];
		for (const method of ["handleClearCommand", "handleBugCommand", "shutdown"])
			instance[method] = () => effects.push(method);
		instance.onInputCallback = (text: string) => effects.push(`prompt:${text}`);
		const web = { name: "web", description: "Open the web workspace" };
		const skills = ["octocode-agentic-prompts", "octocode-research"].map((name) => ({ name, description: "Skill" }));
		instance.getSlashCommands = () => [...BUILTIN_SLASH_COMMANDS, web, ...skills];
		// `/octocode` is a registered command again (B58, the research CLI), so it is no longer a retired name here.
		for (const text of ["/wbe", "/workspace", "/dog"]) await instance.defaultEditor.onSubmit(text);
		// Without `/web` registered, a 3-letter word two edits from `/new` is not a typo of it.
		instance.getSlashCommands = () => BUILTIN_SLASH_COMMANDS;
		await instance.defaultEditor.onSubmit("/web");
		expect(effects).toEqual([]);
		expect(instance.showWarning.mock.calls.map(([message]: [string]) => message)).toEqual(
			[
				"Unknown command /wbe. Did you mean /web?",
				"Unknown command /workspace. Did you mean /web?",
				"Unknown command /dog. Search commands with /help dog.",
				"Unknown command /web. Search commands with /help web.",
			].map((message) => message + HINT),
		);
		expect(instance.editor.setText.mock.calls.map(([text]: [string]) => text)).toEqual([
			"/wbe",
			"/workspace",
			"/dog",
			"/web",
		]);
	});

	it("dispatches /providers to the provider manager and refuses unavailable native commands", async () => {
		const instance = mode();
		instance.handleProvidersCommand = vi.fn();
		await instance.defaultEditor.onSubmit("/providers");
		await instance.defaultEditor.onSubmit("/providers anthropic");
		expect(instance.handleProvidersCommand.mock.calls).toEqual([[undefined], ["anthropic"]]);
		await instance.defaultEditor.onSubmit("/agents");
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

	it("quits through the cleanup path, but refuses unexpected arguments", async () => {
		const instance = mode();
		instance.shutdown = vi.fn();
		await instance.defaultEditor.onSubmit("/quit");
		await instance.defaultEditor.onSubmit("/quit");
		await instance.defaultEditor.onSubmit("/quit later");
		expect(instance.shutdown).toHaveBeenCalledTimes(2);
		expect(instance.showWarning).toHaveBeenCalledWith(`/quit does not take arguments.${HINT}`);
		expect(instance.editor.setText).toHaveBeenLastCalledWith("/quit later");
	});

	it("keeps slash text no command accepts, and sends it as a literal message on a second Enter", async () => {
		const handler = vi.fn();
		const instance = mode([{ name: "harness", argumentWords: ["list", "hooks"], handler, sourceInfo: {} }]);
		instance.getSlashCommands = () => [...BUILTIN_SLASH_COMMANDS, { name: "harness" }];
		instance.shutdown = vi.fn();
		for (const text of ["/harness shows only skills", "/quit after the tests pass", "/dog walks"]) {
			await instance.defaultEditor.onSubmit(text);
			expect(instance.editor.setText).toHaveBeenLastCalledWith(text);
			expect(instance.prompts).toEqual([]);
			await instance.defaultEditor.onSubmit(text);
			expect(instance.prompts.pop()).toEqual([text, expect.objectContaining({ expandPromptTemplates: false })]);
		}
		expect(instance.showWarning.mock.calls.map(([message]: [string]) => message)).toEqual([
			`/harness has no "shows" option; /help harness shows its usage.${HINT}`,
			`/quit does not take arguments.${HINT}`,
			`Unknown command /dog. Search commands with /help dog.${HINT}`,
		]);
		expect(handler).not.toHaveBeenCalled();
		expect(instance.shutdown).not.toHaveBeenCalled();
	});

	it("keeps a refused literal in the editor while compaction runs", async () => {
		const instance = mode();
		instance.getSlashCommands = () => BUILTIN_SLASH_COMMANDS;
		await instance.defaultEditor.onSubmit("/dog walks");
		instance.session.isCompacting = true;
		await instance.defaultEditor.onSubmit("/dog walks");
		expect(instance.prompts).toEqual([]);
		expect(instance.editor.setText).toHaveBeenLastCalledWith("/dog walks");
		instance.session.isCompacting = false;
		await instance.defaultEditor.onSubmit("/dog walks");
		expect(instance.prompts.map(([text]: [string]) => text)).toEqual(["/dog walks"]);
	});

	it("asks again after other input, and still runs declared first words", async () => {
		const instance = mode([{ name: "harness", argumentWords: ["list"], handler: vi.fn(), sourceInfo: {} }]);
		instance.getSlashCommands = () => [...BUILTIN_SLASH_COMMANDS, { name: "harness" }];
		instance.onInputCallback = vi.fn();
		await instance.defaultEditor.onSubmit("/harness is slow");
		await instance.defaultEditor.onSubmit("/harness List");
		await instance.defaultEditor.onSubmit("/harness is slow");
		expect(instance.prompts).toEqual([]);
		expect(instance.showWarning).toHaveBeenCalledTimes(2);
		expect(instance.onInputCallback).toHaveBeenCalledWith("/harness List");
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
		// /clear and /reset start over exactly like /new, including the optional name for the previous session.
		await instance.defaultEditor.onSubmit("/clear");
		await instance.defaultEditor.onSubmit("/reset old work");
		expect(instance.handleClearCommand.mock.calls).toEqual([[undefined], [undefined], ["old work"]]);
		expect(instance.handleCloneCommand).toHaveBeenCalledOnce();
		expect(instance.showUserMessageSelector).toHaveBeenCalledOnce();
	});

	it("prints /status once, from the native owner, and routes the session browser to it", async () => {
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
				{ name: "status", sourceInfo: { owner: "builtin", path: "builtin:foreign" }, handler: foreign },
				{ name: "status", sourceInfo: { owner: "native", path: "<inline:octocode>" }, handler: status },
				{ name: "resume", sourceInfo: { owner: "native", path: "<inline:octocode>" }, handler: resume },
			],
		};
		await instance.defaultEditor.onSubmit("/status");
		await instance.defaultEditor.onSubmit("/resume project");
		await instance.defaultEditor.onSubmit("/resume all");
		expect(instance.handleSessionCommand).not.toHaveBeenCalled();
		expect(status).toHaveBeenCalledOnce();
		expect(resume).toHaveBeenNthCalledWith(1, "project", context);
		expect(resume).toHaveBeenNthCalledWith(2, "all", context);
		expect(foreign).not.toHaveBeenCalled();
		expect(instance.showSessionSelector).not.toHaveBeenCalled();
	});

	it("falls back to the session statistics for /status when native features are disabled", async () => {
		const instance = mode();
		instance.handleSessionCommand = vi.fn();
		await instance.defaultEditor.onSubmit("/status");
		expect(instance.handleSessionCommand).toHaveBeenCalledOnce();
	});

	it("falls back to core resume when native features are disabled", async () => {
		const instance = mode();
		instance.showSessionSelector = vi.fn();
		await instance.defaultEditor.onSubmit("/resume");
		expect(instance.showSessionSelector).toHaveBeenCalledOnce();
	});

	it("has no built-in /trust: the one command is the native one", () => {
		expect(getBuiltinCommand("trust")).toBeUndefined();
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
			{ name: "modelsettings", sourceInfo: { owner: "native", path: "<inline:octocode>" }, handler: catalog },
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

it("keeps native resume hints visible in the TUI", () => {
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
	expect(commands.find((command: any) => command.name === "resume").getArgumentCompletions("")).toEqual([
		{ value: "all", label: "all" },
	]);
	expect(commands.find((command: any) => command.name === "import").argumentKind).toBe("path");
});
