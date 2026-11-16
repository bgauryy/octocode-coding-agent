import { handleWorkflowCommand } from "./workflow-commands.ts";
/**
 * What happens when the editor is submitted: startup input, bash and slash commands, native and built-in commands,
 * the command picker, and prompts sent to the session.
 */

import { getBuiltinCommand, parseSlashCommand } from "../../../core/slash-commands.ts";
import { CommandSelectorComponent } from "../components/command-selector.ts";
import { findCommand, menuCommands, showCommandUsage } from "./command-menu.ts";
import { type ConfigurationHost, handleConfigurationCommand } from "./configuration-command.ts";
import type { InteractiveModeHost } from "./host.ts";
import { runTerminalAction } from "../terminal-actions.ts";
import { handleInputDuringCompaction } from "./message-queue.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { handleForkLaunchCommand } from "./fork-launch.ts";
import { unknownCommandWarning } from "./command-suggestion.ts";
import {
	argumentWordRefusal,
	clearRefused,
	handleRefused,
	refusedInput,
	refuseWith,
	restoreRefused,
} from "./refused-input.ts";
import { interruptKey } from "../../../theme/theme-tui-helpers.ts";
import { showFooterStatusReport } from "./footer-status-report.ts";

/** Interactive-mode members used by the editor submit handler and command dispatch. */
type CommandDispatchHost = ConfigurationHost &
	Pick<
		InteractiveModeHost,
		| "chatContainer"
		| "defaultEditor"
		| "editor"
		| "flushPendingBashComponents"
		| "footerDataProvider"
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
		| "handleProvidersCommand"
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
		| "showStatus"
		| "showTreeSelector"
		| "showUserMessageSelector"
		| "showWarning"
		| "shutdown"
		| "skillCommands"
		| "ui"
		| "uiStore"
	>;

/** The prompt submitted while startup runs, per interactive mode: sent once, when startup is ready. */
const startupSubmits = new WeakMap<object, string>();

/**
 * Enter before startup finished: the text stays in the editor, queued, and `dispatchStartupSubmit` sends it once ready.
 * A second Enter replaces the queued text; Esc cancels it; editing or clearing it means the user is still composing.
 */
export function handleStartupSubmit(host: CommandDispatchHost, text: string): void {
	restoreRefused(host.editor, text);
	if (!text.trim()) {
		host.showStatus("Startup is still in progress");
		return;
	}
	startupSubmits.set(host, text);
	const cancelKey = interruptKey();
	host.showStatus(`Sends when startup finishes${cancelKey ? ` · ${cancelKey} cancels` : ""}`);
}

/** Esc during startup: drop the queued submit and keep its text in the editor. */
export function cancelStartupSubmit(host: Pick<CommandDispatchHost, "showStatus">): void {
	if (startupSubmits.delete(host)) host.showStatus("Not sent: the prompt stays in the editor");
}

/**
 * Startup is ready: send the queued submit once, unless the editor no longer holds the text that was queued (both
 * trimmed, as a submit trims: an editor may pass its text untrimmed). Changed text stays in the editor, with a status.
 */
export function dispatchStartupSubmit(host: Pick<CommandDispatchHost, "editor" | "showStatus">): void {
	const text = startupSubmits.get(host);
	startupSubmits.delete(host);
	if (text === undefined) return;
	const editor = host.editor;
	const current = (editor.getExpandedText?.() ?? editor.getText()).trim();
	if (current !== text.trim()) {
		if (current) host.showStatus("Not sent: the prompt changed after Enter and stays in the editor");
		return;
	}
	if (editor.submit) {
		editor.submit();
		return;
	}
	editor.setText("");
	editor.onSubmit?.(text);
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

async function showCommandPicker(host: CommandDispatchHost, query = ""): Promise<void> {
	const all = host.getSlashCommands(true);
	const named = findCommand(all, query);
	if (named) return showCommandUsage(host, named);
	const commands = menuCommands(all);
	host.showSelector((done) => {
		const selector = new CommandSelectorComponent(
			"Commands",
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
	if (await runTerminalAction(host, name, args)) return;
	switch (name) {
		case "btw":
		case "context":
		case "diff":
			await handleWorkflowCommand(host, name, args);
			return;
		case "help":
			await showCommandPicker(host, args);
			return;
		case "configuration":
			await handleConfigurationCommand(host, args);
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
			// Native summary when available, session statistics otherwise; full live statuses follow either report.
			if (!(await runNativeCommand(host, "status"))) host.handleSessionCommand();
			showFooterStatusReport(host);
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
		case "providers":
			await host.handleProvidersCommand(args || undefined);
			return;
		case "logout":
			await host.showOAuthSelector("logout", args.trim() || undefined);
			return;
		case "permissions":
		case "agents":
		case "realm":
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

/**
 * Why slash input `/name args` is not run as a command: an unknown name, arguments to a built-in that takes none, or a
 * first word a command does not declare (`argumentWords`). Undefined when the input runs.
 */
function slashRefusal(host: CommandDispatchHost, text: string, name: string, args: string): string | undefined {
	const builtin = getBuiltinCommand(name);
	if (builtin) return args && !builtin.argumentHint ? `/${name} does not take arguments.` : undefined;
	const unknown = unknownCommandWarning(text, name, host.getSlashCommands(true));
	if (unknown) return unknown;
	return argumentWordRefusal(name, args, host.session.extensionRunner.getCommand(name)?.argumentWords);
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
		// Text that starts with `/` may be a message about a command: a refusal keeps it, and Enter again sends it.
		const refusal = parsed && slashRefusal(host, text, parsed.name, parsed.args);
		const input = refusedInput(host);
		if (refusal) return handleRefused(input, text, refusal);
		clearRefused(input);
		if (builtin) {
			host.editor.setText("");
			try {
				await runBuiltinCommand(host, builtin.name, parsed.args);
			} catch (error) {
				host.showError(errorMessage(error));
			}
			return;
		}
		// Handle bash command (! for normal, !! for excluded from context)
		if (text.startsWith("!")) {
			const isExcluded = text.startsWith("!!");
			const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
			if (command) {
				if (host.session.isBashRunning)
					return refuseWith(input, text, "A bash command is already running. Press Esc to cancel it first.");
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
