import { handleWorkflowCommand } from "./workflow-commands.ts";
/**
 * What happens when the editor is submitted: startup input, bash and slash commands, native and built-in commands,
 * the command picker, and prompts sent to the session.
 */

import { getBuiltinCommand, parseSlashCommand } from "../../../core/slash-commands.ts";
import { NATIVE_FEATURE_PATH } from "../../../core/native-tools.ts";
import { CommandSelectorComponent } from "../components/command-selector.ts";
import type { InteractiveModeHost } from "./host.ts";
import { handleInputDuringCompaction } from "./message-queue.ts";
import { errorMessage } from "../../../utils/guards.ts";
import { handleForkLaunchCommand } from "./fork-launch.ts";
import { handleSkillsCommand } from "./skills-command.ts";
import { closeNames } from "../../../octocode/skill/catalog.ts";

/** Interactive-mode members used by the editor submit handler and command dispatch. */
type CommandDispatchHost = Pick<
	InteractiveModeHost,
	| "chatContainer"
	| "defaultEditor"
	| "editor"
	| "flushPendingBashComponents"
	| "getMarkdownThemeWithSettings"
	| "getSlashCommands"
	| "handleBashCommand"
	| "handleBugCommand"
	| "handleChangelogCommand"
	| "handleClearCommand"
	| "handleCloneCommand"
	| "handleCompactCommand"
	| "handleCopyCommand"
	| "handleDebugCommand"
	| "handleExportCommand"
	| "handleGithubCommand"
	| "handleHotkeysCommand"
	| "handleImportCommand"
	| "handleLoginCommand"
	| "handleModelCommand"
	| "handleNameCommand"
	| "handleReloadCommand"
	| "handleSessionCommand"
	| "handleShareCommand"
	| "handleThinkingCommand"
	| "isBashMode"
	| "isExtensionCommand"
	| "onInputCallback"
	| "pendingUserInputs"
	| "queueCompactionMessage"
	| "queueInteractiveMessage"
	| "runtimeHost"
	| "sessionManager"
	| "session"
	| "showExtensionConfirm"
	| "showError"
	| "showExtensionSelector"
	| "showExtensionCustom"
	| "showModelsSelector"
	| "showOAuthSelector"
	| "showQueueManager"
	| "showSelector"
	| "showSessionSelector"
	| "showSettingsSelector"
	| "showStatus"
	| "showTreeSelector"
	| "showTrustSelector"
	| "showUserMessageSelector"
	| "showWarning"
	| "shutdown"
	| "skillCommands"
	| "ui"
	| "updateEditorBorderColor"
>;

export function handleStartupSubmit(host: CommandDispatchHost, text: string): void {
	host.editor.setText(text);
	host.showStatus("Startup is still in progress");
}

function getNativeCommand(host: CommandDispatchHost, name: string) {
	return host.session.extensionRunner
		.getRegisteredCommands()
		.find((command) => command.name === name && command.sourceInfo.path === NATIVE_FEATURE_PATH);
}

async function runNativeCommand(host: CommandDispatchHost, name: string, args = ""): Promise<boolean> {
	const command = getNativeCommand(host, name);
	if (!command) return false;
	await command.handler(args, host.session.extensionRunner.createCommandContext());
	return true;
}

function showCommandPicker(host: CommandDispatchHost, query = "", skillsOnly = false): void {
	const commands = host.getSlashCommands(true).filter((command) => !skillsOnly || host.skillCommands.has(command.name));
	host.showSelector((done) => {
		const selector = new CommandSelectorComponent(
			skillsOnly ? "Skills" : "Commands",
			commands,
			(name) => {
				done();
				host.editor.setText(`/${name} `);
				host.ui.requestRender();
			},
			done,
			query,
		);
		return { component: selector, focus: selector };
	});
}

const CREDENTIAL_CHECK = "Credential check — one tiny request per provider, then the catalog";

async function showModelsMenu(host: CommandDispatchHost): Promise<void> {
	const choices = [
		"Model shortcuts — choose models for keyboard cycling",
		...(getNativeCommand(host, "modelsettings")
			? ["Model catalog — prices, capabilities and agent routing", CREDENTIAL_CHECK]
			: []),
	];
	const llama = host.session.extensionRunner.getCommand("llama");
	if (llama) choices.push("Local llama.cpp models");
	const choice = await host.showExtensionSelector("Model settings — /model switches this chat's model", choices);
	if (choice === choices[0]) host.showModelsSelector();
	else if (choice === "Model catalog — prices, capabilities and agent routing")
		await runNativeCommand(host, "modelsettings");
	else if (choice === CREDENTIAL_CHECK) await runNativeCommand(host, "modelsettings", "check");
	else if (choice === "Local llama.cpp models" && llama)
		await llama.handler("", host.session.extensionRunner.createCommandContext());
}

async function showTrustMenu(host: CommandDispatchHost): Promise<void> {
	if (!getNativeCommand(host, "trust")) {
		host.showTrustSelector();
		return;
	}
	const choice = await host.showExtensionSelector("Project trust", [
		"Project resources",
		"Native project configuration",
		"Revoke native configuration trust",
	]);
	if (choice === "Project resources") host.showTrustSelector();
	else if (choice === "Native project configuration") await runNativeCommand(host, "trust");
	else if (choice === "Revoke native configuration trust") await runNativeCommand(host, "trust", "off");
}

async function runBuiltinCommand(host: CommandDispatchHost, name: string, args: string): Promise<void> {
	if (args && !getBuiltinCommand(name)?.argumentHint) {
		host.showWarning(`/${name} does not take arguments.`);
		return;
	}
	switch (name) {
		case "btw":
		case "context":
		case "diff":
			await handleWorkflowCommand(host, name, args);
			return;
		case "help":
			showCommandPicker(host, args);
			return;
		case "skills":
			if (!(await handleSkillsCommand(host, args || "list"))) showCommandPicker(host, args, true);
			return;
		case "settings":
			host.showSettingsSelector();
			return;
		case "modelsettings":
			if (args.trim() === "check" && (await runNativeCommand(host, "modelsettings", "check"))) return;
			if (args.trim() && args.trim() !== "check") return host.showWarning("Usage: /modelsettings [check]");
			await showModelsMenu(host);
			return;
		case "model":
			await host.handleModelCommand(args || undefined);
			return;
		case "effort":
			host.handleThinkingCommand(args || undefined);
			return;
		case "export":
			await host.handleExportCommand(`/export${args ? ` ${args}` : ""}`);
			return;
		case "import":
			await host.handleImportCommand(`/import${args ? ` ${args}` : ""}`);
			return;
		case "share":
			await host.handleShareCommand();
			return;
		case "bug":
			await host.handleBugCommand(args || undefined);
			return;
		case "copy":
			await host.handleCopyCommand();
			return;
		case "rename":
			host.handleNameCommand(`/name${args ? ` ${args}` : ""}`);
			return;
		case "status":
			host.handleSessionCommand();
			await runNativeCommand(host, "status");
			return;
		case "changelog":
			host.handleChangelogCommand();
			return;
		case "keys":
			host.handleHotkeysCommand();
			return;
		case "fork":
			if (args.trim()) await handleForkLaunchCommand(host, args);
			else host.showUserMessageSelector();
			return;
		case "clone":
			await host.handleCloneCommand();
			return;
		case "tree":
			host.showTreeSelector();
			return;
		case "queue":
			host.showQueueManager();
			return;
		case "trust":
			if (!args) await showTrustMenu(host);
			else if (args === "project") host.showTrustSelector();
			else if (args === "config" || args === "off") {
				if (!(await runNativeCommand(host, "trust", args === "off" ? "off" : "")))
					host.showWarning("Native project configuration is unavailable.");
			} else host.showWarning("Usage: /trust [project|config|off]");
			return;
		case "login":
			await host.handleLoginCommand(args || undefined);
			return;
		case "logout":
			await host.showOAuthSelector("logout");
			return;
		case "github":
			await host.handleGithubCommand(args);
			return;
		case "permissions":
		case "agents":
		case "plan":
			if (!(await runNativeCommand(host, name, args))) host.showWarning(`/${name} requires native features.`);
			return;
		case "new":
			await host.handleClearCommand(args || undefined);
			return;
		case "compact":
			await host.handleCompactCommand(args || undefined);
			return;
		case "reload":
			await host.handleReloadCommand();
			return;
		case "debug":
			host.handleDebugCommand();
			return;
		case "resume":
			if (!(await runNativeCommand(host, "resume", args))) host.showSessionSelector();
			return;
		case "quit":
			// Quitting mid-reply discards the reply; ask, as /new and /fork do for running work.
			if (host.session.isStreaming && !(await host.showExtensionConfirm("Quit", "Stop the running reply and quit?")))
				return;
			await host.shutdown();
			return;
	}
}

/** A warning for a command-shaped `/name` that no command owns, naming the closest command when one is close. */
function unknownCommandWarning(host: CommandDispatchHost, name: string): string | undefined {
	if (!/^[a-z][a-z0-9-]*$/i.test(name)) return undefined;
	const names = host.getSlashCommands(true).map((command) => command.name);
	if (names.includes(name)) return undefined;
	const [closest] = closeNames(name, names);
	return closest
		? `Unknown command /${name}. Did you mean /${closest}?`
		: `Unknown command /${name}. Search commands with /help ${name}.`;
}

export function setupEditorSubmitHandler(host: CommandDispatchHost): void {
	host.defaultEditor.onSubmit = async (text: string) => {
		text = text.trim();
		if (!text) return;

		const parsed = parseSlashCommand(text);
		const builtin = parsed && getBuiltinCommand(parsed.name);
		if (builtin) {
			host.editor.setText("");
			try {
				await runBuiltinCommand(host, builtin.name, parsed.args);
			} catch (error) {
				host.showError(errorMessage(error));
			}
			return;
		}
		const unknown = parsed && unknownCommandWarning(host, parsed.name);
		if (unknown) {
			host.editor.setText(text);
			host.showWarning(unknown);
			return;
		}

		// Handle bash command (! for normal, !! for excluded from context)
		if (text.startsWith("!")) {
			const isExcluded = text.startsWith("!!");
			const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
			if (command) {
				if (host.session.isBashRunning) {
					host.showWarning("A bash command is already running. Press Esc to cancel it first.");
					host.editor.setText(text);
					return;
				}
				host.editor.addToHistory?.(text);
				await host.handleBashCommand(command, isExcluded);
				host.isBashMode = false;
				host.updateEditorBorderColor();
				return;
			}
		}

		if (await handleInputDuringCompaction(host, text, "steer")) return;

		// If streaming, use prompt() with steer behavior
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (host.session.isStreaming) {
			await host.queueInteractiveMessage(text, "steer");
			return;
		}

		// Normal message submission
		// First, move any pending bash components to chat
		host.flushPendingBashComponents();

		if (host.onInputCallback) {
			host.onInputCallback(text);
		} else {
			host.pendingUserInputs.push(text);
		}
		host.editor.addToHistory?.(text);
	};
}
