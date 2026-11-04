/**
 * Runs a user `!` or `!!` bash command and shows its output in the chat or the pending area.
 */

import { getApplicationPort } from "../../../core/application/index.ts";
import type { UserBashEventResult } from "../../../core/features/index.ts";
import type { TruncationResult } from "../../../core/tools/truncate.ts";
import { BashExecutionComponent } from "../components/bash-execution.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by user bash commands. */
type BashCommandHost = Pick<
	InteractiveModeHost,
	| "bashComponent"
	| "chatContainer"
	| "outputPad"
	| "pendingBashComponents"
	| "pendingMessagesContainer"
	| "session"
	| "sessionManager"
	| "showError"
	| "ui"
>;

export async function handleBashCommand(
	host: BashCommandHost,
	command: string,
	excludeFromContext = false,
): Promise<void> {
	const extensionRunner = host.session.extensionRunner;

	// Emit user_bash event to let extensions intercept
	let eventResult: UserBashEventResult | undefined;
	try {
		eventResult = await extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: host.sessionManager.getCwd(),
		});
	} catch {
		// The extension runner already reported the error. Do not fall back to local execution.
		return;
	}

	// If extension returned a full result, use it directly
	if (eventResult?.result) {
		const result = eventResult.result;

		// Create UI component for display
		host.bashComponent = new BashExecutionComponent(command, host.ui, excludeFromContext, host.outputPad);
		if (host.session.isStreaming) {
			host.pendingMessagesContainer.addChild(host.bashComponent);
			host.pendingBashComponents.push(host.bashComponent);
		} else {
			host.chatContainer.addChild(host.bashComponent);
		}

		// Show output and complete
		if (result.output) {
			host.bashComponent.appendOutput(result.output);
		}
		host.bashComponent.setComplete(
			result.exitCode,
			result.cancelled,
			result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
			result.fullOutputPath,
			result.header,
		);

		// Record the result in session
		getApplicationPort(host.session).invoke("recordBashResult", command, result, { excludeFromContext });
		host.bashComponent = undefined;
		host.ui.requestRender();
		return;
	}

	// Normal execution path (possibly with custom operations)
	const isDeferred = host.session.isStreaming;
	host.bashComponent = new BashExecutionComponent(command, host.ui, excludeFromContext, host.outputPad);

	if (isDeferred) {
		// Show in pending area when agent is streaming
		host.pendingMessagesContainer.addChild(host.bashComponent);
		host.pendingBashComponents.push(host.bashComponent);
	} else {
		// Show in chat immediately when agent is idle
		host.chatContainer.addChild(host.bashComponent);
	}
	host.ui.requestRender();

	try {
		const result = await getApplicationPort(host.session).invoke(
			"executeBash",
			command,
			(chunk) => {
				if (host.bashComponent) {
					host.bashComponent.appendOutput(chunk);
					host.ui.requestRender();
				}
			},
			{ excludeFromContext, operations: eventResult?.operations },
		);

		if (host.bashComponent) {
			// The streamed tail is bounded and folds redrawn lines; the result holds the whole (trimmed) output.
			host.bashComponent.replaceOutput(result.output);
			host.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
				result.header,
			);
		}
	} catch (error) {
		if (host.bashComponent) {
			host.bashComponent.setComplete(undefined, false);
		}
		host.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
	}

	host.bashComponent = undefined;
	host.ui.requestRender();
}
