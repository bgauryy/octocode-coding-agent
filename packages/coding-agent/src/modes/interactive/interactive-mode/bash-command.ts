import { errorMessage } from "@octocodeai/octocode-contracts/guards";
/**
 * Runs a user `!` or `!!` bash command and shows its output in the chat or the pending area.
 */

import { getApplicationPort } from "../../../core/application/index.ts";
import { UserBashHookError } from "../../../core/agent-session/user-bash.ts";
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
	| "showError"
	| "ui"
>;

export async function handleBashCommand(
	host: BashCommandHost,
	command: string,
	excludeFromContext = false,
): Promise<void> {
	// While a run streams, the command waits with the pending messages; otherwise it joins the chat.
	const show = (): BashExecutionComponent => {
		const component = new BashExecutionComponent(command, host.ui, excludeFromContext, host.outputPad);
		host.bashComponent = component;
		if (host.session.isStreaming) {
			host.pendingMessagesContainer.addChild(component);
			host.pendingBashComponents.push(component);
		} else host.chatContainer.addChild(component);
		host.ui.requestRender();
		return component;
	};

	try {
		const result = await getApplicationPort(host.session).invoke("runUserBash", command, {
			excludeFromContext,
			onStart: show,
			onChunk: (chunk) => {
				if (!host.bashComponent) return;
				host.bashComponent.appendOutput(chunk);
				host.ui.requestRender();
			},
		});
		// A handler's result arrives whole; a command run here streamed into the component `onStart` showed.
		const component = host.bashComponent ?? show();
		// The streamed tail is bounded and folds redrawn lines; the result holds the whole (trimmed) output.
		component.replaceOutput(result.output);
		component.setComplete(
			result.exitCode,
			result.cancelled,
			result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
			result.fullOutputPath,
			result.header,
		);
	} catch (error) {
		host.bashComponent?.setComplete(undefined, false);
		// A failing `user_bash` handler was already reported as an extension error, and nothing ran.
		if (!(error instanceof UserBashHookError)) host.showError(`Bash command failed: ${errorMessage(error)}`);
	}

	host.bashComponent = undefined;
	host.ui.requestRender();
}
