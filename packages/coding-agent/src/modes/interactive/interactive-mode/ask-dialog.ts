import type { SessionUI } from "../../../core/features/index.ts";
import { type DialogUi, degrade } from "../../../octocode/ask/degrade.ts";
import { plainTitle, viewOf } from "../../../octocode/ask/question.ts";
import type { InteractiveModeHost } from "./host.ts";

type AskHost = Pick<InteractiveModeHost, "showConfirmDialog" | "showInputDialog" | "showSelectorDialog">;

/**
 * `ui.ask` for the terminal, for the questions its tabbed dialog does not draw (`octocode/ask/ask.ts` sends text, choice
 * and multi batches there): confirmations and permission prompts, one at a time. An approval is the selector drawn as its
 * card, reported as a permission while it waits, with the note typed in its write-in handed back with the pick; every
 * other question is a plain dialog.
 */
export function askInTerminal(host: AskHost): NonNullable<SessionUI["ask"]> {
	const ui: DialogUi = {
		select: (title, options, opts) => host.showSelectorDialog(title, options, opts),
		confirm: (title, message, opts) => host.showConfirmDialog(title, message, opts),
		input: (title, placeholder, opts) => host.showInputDialog(title, placeholder, opts),
		approve: async (question, dialog) => {
			let note: string | undefined;
			const label = await host.showSelectorDialog(
				plainTitle(question),
				(question.options ?? []).map((option) => option.label),
				dialog,
				{ kind: "permission", message: question.question },
				{ view: viewOf(question), onWriteIn: (text) => void (note = text) },
			);
			return label === undefined ? undefined : { label, ...(note !== undefined ? { note } : {}) };
		},
	};
	return (questions, opts) => degrade(ui, questions, opts);
}
