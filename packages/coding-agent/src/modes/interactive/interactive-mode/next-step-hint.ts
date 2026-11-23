/**
 * Shows the registry's next-step hint (`core/command-next-steps.ts`) as one dim line after a command's result, for
 * built-ins run by the dispatcher and for feature commands sent through the session prompt.
 */

import { ThemedText } from "@octocodeai/octocode-tui";
import { nextStepFor } from "../../../core/command-next-steps.ts";
import type { PromptOptions } from "../../../core/agent-session/types.ts";
import { parseSlashCommand } from "../../../core/slash-commands.ts";
import { hintLine } from "../../../theme/hints.ts";
import { problemsShown } from "./display.ts";
import type { InteractiveModeHost } from "./host.ts";

type HintHost = Pick<InteractiveModeHost, "chatContainer" | "ui">;

/** The command's registry hint as one dim line after its result (a status line would replace that result). */
function showNextStep(host: HintHost, name: string, args = ""): void {
	const step = nextStepFor(name, args);
	if (!step) return;
	host.chatContainer.addChild(new ThemedText(() => hintLine([step]), 1, 0));
	host.ui.requestRender();
}

/**
 * Call before a command runs; the returned function shows its hint after it, unless the run showed a warning or an
 * error: that notice already says what went wrong and what to do (a usage line, "nothing to copy yet", a refused
 * worktree), and a hint for the success path beside it misleads.
 */
export function hintAfterRun(host: HintHost): (name: string, args?: string) => void {
	const before = problemsShown(host);
	return (name, args) => {
		if (problemsShown(host) === before) showNextStep(host, name, args);
	};
}

/**
 * A `preflightResult` that shows the hint once a feature command in `text` finished without failing or warning. Any
 * other text (a prompt, a skill, input a handler consumed) shows nothing; `then` still hears every disposition.
 */
export function featureCommandHint(
	host: HintHost & Pick<InteractiveModeHost, "session">,
	text: string,
	then?: PromptOptions["preflightResult"],
): NonNullable<PromptOptions["preflightResult"]> {
	const hint = hintAfterRun(host);
	return (disposition, commandFailure) => {
		then?.(disposition, commandFailure);
		if (disposition !== "handled" || commandFailure !== undefined) return;
		const parsed = parseSlashCommand(text);
		if (parsed && host.session.featureHost.getCommand(parsed.name)) hint(parsed.name, parsed.args);
	};
}
