import { handleWorkflowCommand } from "./workflow-commands.ts";
/**
 * What happens when the editor is submitted: startup input, bash and slash commands, native and built-in commands,
 * the command picker, and prompts sent to the session.
 */

import { getBuiltinCommand, parseSlashCommand } from "../../../core/slash-commands.ts";
import { CommandSelectorComponent } from "../components/command-selector.ts";
import type { InteractiveModeHost } from "./host.ts";
import { handleInputDuringCompaction } from "./message-queue.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { handleForkLaunchCommand } from "./fork-launch.ts";
import { handleSkillsCommand } from "./skills-command.ts";
import { unknownCommandWarning } from "./command-suggestion.ts";

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
	| "handleHotkeysCommand"
	| "handleImportCommand"
	| "handleLoginCommand"
	| "handleModelCommand"
	| "handleNameCommand"
	| "handleReloadCommand"
	| "handleSessionCommand"
	| "handleShareCommand"
	| "handleThinkingCommand"
	| "isExtensionCommand"
	| "onInputCallback"
	| "pendingUserInputs"
	| "queueCompactionMessage"
	| "queueInteractiveMessage"
	| "runtimeHost"
	| "sessionManager"
	| "sendCarriedMessages"
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
	| "showUserMessageSelector"
	| "showWarning"
	| "shutdown"
	| "skillCommands"
	| "ui"
	| "uiStore"
>;

export function handleStartupSubmit(host: CommandDispatchHost, text: string): void {
	host.editor.setText(text);
	host.showStatus("Startup is still in progress");
}

function getNativeCommand(host: CommandDispatchHost, name: string) {
	return host.session.extensionRunner
		.getRegisteredCommands()
		.find((command) => command.name === name && command.sourceInfo.owner === "native");
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
		case "login":
			await host.handleLoginCommand(args || undefined);
			return;
		case "logout":
			await host.showOAuthSelector("logout");
			return;
		case "permissions":
		case "agents":
		case "plan":
			if (!(await runNativeCommand(host, name, args))) host.showWarning(`/${name} requires native features.`);
			return;
		case "new":
		case "clear":
		case "reset":
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
		case "quit": {
			// Quitting discards a running reply and stops background work: the native check asks, as it does for /new and /fork.
			const runner = host.session.extensionRunner;
			const guarded = runner?.hasHandlers("session_before_quit");
			if (guarded ? (await runner?.emit({ type: "session_before_quit" }))?.cancel : false) {
				host.showStatus("Still running: quit cancelled.");
				return;
			}
			if (
				guarded ||
				!host.session.isStreaming ||
				(await host.showExtensionConfirm("Quit", "Stop the running reply and quit?"))
			)
				await host.shutdown();
		}
	}
}

export function setupEditorSubmitHandler(host: CommandDispatchHost): void {
	// oxlint-disable-next-line typescript/no-misused-promises -- the editor ignores the callback's result
	host.defaultEditor.onSubmit = async (submitted: string) => {
		const text = submitted.trim();
		if (!text) {
			// Enter in an empty editor sends the messages carried over a session switch.
			await host.sendCarriedMessages();
			return;
		}

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
		const unknown = parsed && unknownCommandWarning(text, parsed.name, host.getSlashCommands(true));
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
				host.uiStore.getState().setBashMode(false);
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
