/**
 * Shows the registry's next-step hint (`core/command-next-steps.ts`) as one dim line after a command's result, for
 * built-ins run by the dispatcher and for feature commands sent through the session prompt.
 */

import { ThemedText } from "@octocodeai/octocode-tui";
import { nextStepFor } from "../../../core/command-next-steps.ts";
import type { PromptOptions } from "../../../core/agent-session/types.ts";
import { parseSlashCommand } from "../../../core/slash-commands.ts";
import { hintLine } from "../../../theme/hints.ts";
import type { InteractiveModeHost } from "./host.ts";

type HintHost = Pick<InteractiveModeHost, "chatContainer" | "ui">;

/** The command's registry hint as one dim line after its result (a status line would replace that result). */
export function showNextStep(host: HintHost, name: string, args = ""): void {
	const step = nextStepFor(name, args);
	if (!step) return;
	host.chatContainer.addChild(new ThemedText(() => hintLine([step]), 1, 0));
	host.ui.requestRender();
}

/**
 * A `preflightResult` that shows the hint once a feature command in `text` finished without failing. Any other text
 * (a prompt, a skill, input a handler consumed) shows nothing; `then` still hears every disposition.
 */
export function featureCommandHint(
	host: HintHost & Pick<InteractiveModeHost, "session">,
	text: string,
	then?: PromptOptions["preflightResult"],
): NonNullable<PromptOptions["preflightResult"]> {
	return (disposition, commandFailure) => {
		then?.(disposition, commandFailure);
		if (disposition !== "handled" || commandFailure !== undefined) return;
		const parsed = parseSlashCommand(text);
		if (parsed && host.session.featureHost.getCommand(parsed.name)) showNextStep(host, parsed.name, parsed.args);
	};
}
