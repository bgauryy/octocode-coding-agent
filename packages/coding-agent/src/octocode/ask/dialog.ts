import { Editor } from "@octocodeai/octocode-tui";
import type { Question, Reply } from "@octocodeai/octocode-contracts";
import type { FeatureContext } from "../../core/features/index.ts";
import { titledDialog } from "../shared/locks.ts";
import { AskDialog } from "./dialog/component.ts";
import { remoteAnswer } from "./dialog/view.ts";
import { editorTheme } from "./dialog/theme.ts";

/**
 * Inline question dialog (adapted from Octocode's questionnaire example): a tab per
 * question plus Submit, ↑↓ to move (stopping at the ends) and a free-text row on every question.
 * Single-choice questions answer on Enter; multi-select questions toggle with
 * Space or Enter and answer only from their own "Submit selection" row. The wheel
 * moves one option, a press selects one, and a click on the selected one acts as
 * Enter unless an option is marked dangerous.
 */
export function showAskDialog(
	ctx: Pick<FeatureContext, "ui">,
	questions: readonly Question[],
	signal?: AbortSignal,
): Promise<Reply[]> {
	const cancelled = (reason: "declined" | "aborted"): Reply[] =>
		questions.map((q) => ({ id: q.id, cancelled: reason }));
	if (signal?.aborted) return Promise.resolve(cancelled("aborted"));
	// The working line and the dialog notification name the question (the count first, so clipping keeps it).
	const title = `${questions.length > 1 ? `${questions.length} questions: ` : ""}${questions[0]?.question ?? ""}`;
	// The remote answer's `hold` reaches the dialog the factory builds.
	let shown: AskDialog | undefined;
	return titledDialog(title, () =>
		ctx.ui
			.custom<Reply[]>(
				(tui, theme, keybindings, done) =>
					(shown = new AskDialog(
						questions,
						keybindings,
						theme,
						new Editor(tui, editorTheme(theme)),
						() => tui.requestRender(),
						done,
						signal,
					)),
				remoteAnswer(questions, () => shown?.hold()),
			)
			// Closed without an answer (another view took its place, or the UI was reset): a dismissal.
			.then((replies) => replies ?? cancelled("declined")),
	);
}
