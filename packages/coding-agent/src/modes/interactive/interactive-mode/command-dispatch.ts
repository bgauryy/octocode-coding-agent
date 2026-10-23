/**
 * What happens when the editor is submitted: startup input, bash and slash commands, native and built-in commands,
 * the command picker, and prompts sent to the session.
 */

import { getApplicationPort } from "../../../core/application/index.ts";
import { getBuiltinCommand, parseSlashCommand } from "../../../core/slash-commands.ts";
import { NATIVE_FEATURE_PATH } from "../../../core/native-tools.ts";
import { CommandSelectorComponent } from "../components/command-selector.ts";
import type { InteractiveModeHost } from "./host.ts";
import { errorMessage } from "../../../utils/guards.ts";

/** Interactive-mode members used by the editor submit handler and command dispatch. */
export type CommandDispatchHost = Pick<
	InteractiveModeHost,
	| "defaultEditor"
	| "editor"
	| "flushPendingBashComponents"
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
	| "isBashMode"
	| "isExtensionCommand"
	| "onInputCallback"
	| "pendingUserInputs"
	| "queueCompactionMessage"
	| "queueInteractiveMessage"
	| "session"
	| "showError"
	| "showExtensionSelector"
	| "showModelsSelector"
	| "showOAuthSelector"
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

export function getNativeCommand(host: CommandDispatchHost, name: string) {
	return host.session.extensionRunner
		.getRegisteredCommands()
		.find((command) => command.name === name && command.sourceInfo.path === NATIVE_FEATURE_PATH);
}

export async function runNativeCommand(host: CommandDispatchHost, name: string, args = ""): Promise<boolean> {
	const command = getNativeCommand(host, name);
	if (!command) return false;
	await command.handler(args, host.session.extensionRunner.createCommandContext());
	return true;
}

export function showCommandPicker(host: CommandDispatchHost, query = "", skillsOnly = false): void {
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

export async function showModelsMenu(host: CommandDispatchHost): Promise<void> {
	const choices = ["Model cycling", ...(getNativeCommand(host, "models") ? ["Catalog and agent routing"] : [])];
	const llama = host.session.extensionRunner.getCommand("llama");
	if (llama) choices.push("Local llama.cpp models");
	const choice = await host.showExtensionSelector("Models", choices);
	if (choice === "Model cycling") host.showModelsSelector();
	else if (choice === "Catalog and agent routing") await runNativeCommand(host, "models");
	else if (choice === "Local llama.cpp models" && llama)
		await llama.handler("", host.session.extensionRunner.createCommandContext());
}

export async function showTrustMenu(host: CommandDispatchHost): Promise<void> {
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

export async function runBuiltinCommand(host: CommandDispatchHost, name: string, args: string): Promise<void> {
	if (args && !getBuiltinCommand(name)?.argumentHint) {
		host.showWarning(`/${name} does not take arguments.`);
		return;
	}
	switch (name) {
		case "help":
			showCommandPicker(host, args);
			return;
		case "skills":
			showCommandPicker(host, args, true);
			return;
		case "settings":
			host.showSettingsSelector();
			return;
		case "models":
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
			host.showUserMessageSelector();
			return;
		case "clone":
			await host.handleCloneCommand();
			return;
		case "tree":
			host.showTreeSelector();
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
		case "new":
			await host.handleClearCommand();
			return;
		case "compact":
			await host.handleCompactCommand();
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
			await host.shutdown();
			return;
	}
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

		// Queue input during compaction (extension commands execute immediately)
		if (host.session.isCompacting) {
			if (host.isExtensionCommand(text)) {
				host.editor.addToHistory?.(text);
				host.editor.setText("");
				await getApplicationPort(host.session).invoke("prompt", text);
			} else {
				host.queueCompactionMessage(text, "steer");
			}
			return;
		}

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
