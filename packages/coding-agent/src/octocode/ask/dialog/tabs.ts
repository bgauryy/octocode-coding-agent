import type { KeybindingsManager } from "@octocodeai/octocode-tui";
import type { Question } from "@octocodeai/octocode-contracts";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import { shortcutText } from "../../shared/keys.ts";
import type { AskAnswer } from "./answers.ts";
import { tabMark } from "./marks.ts";
import type { DialogTheme } from "./theme.ts";

/** The tab bar and the review page of a batch of questions, drawn by the dialog. */

const nameOf = (q: Question, index: number): string => sanitizeTerminalText(q.header ?? `Q${index + 1}`);

/** One tab per question plus Submit; `tab === questions.length` is Submit. */
export function tabsLine(
	theme: DialogTheme,
	questions: readonly Question[],
	answers: ReadonlyMap<number, AskAnswer>,
	tab: number,
): string {
	const tabs = questions.map((q, index) => {
		const mark = tabMark(theme, answers.has(index));
		const name = ` ${nameOf(q, index)} `;
		return index === tab
			? theme.bg("selectedBg", `${theme.fg("text", " ")}${mark}${theme.fg("text", name)}`)
			: `${theme.fg("muted", " ")}${mark}${theme.fg(answers.has(index) ? "success" : "muted", name)}`;
	});
	const submit = " ✓ Submit ";
	tabs.push(
		tab === questions.length
			? theme.bg("selectedBg", theme.fg("text", submit))
			: theme.fg(answers.size === questions.length ? "success" : "dim", submit),
	);
	return tabs.join(" ");
}

/** Every question with its answer (or none yet), and whether Enter submits. */
export function renderReview(
	add: (prefix: string, text: string) => void,
	lines: string[],
	theme: DialogTheme,
	questions: readonly Question[],
	answers: ReadonlyMap<number, AskAnswer>,
	keybindings: KeybindingsManager,
): void {
	for (const [index, q] of questions.entries()) {
		const given = answers.get(index);
		add(
			" ",
			`${theme.fg("muted", `${nameOf(q, index)}: `)}${given ? theme.fg("text", sanitizeTerminalText(given.answer)) : theme.fg("warning", "(unanswered)")}`,
		);
	}
	lines.push("");
	add(
		" ",
		answers.size === questions.length
			? theme.fg("success", `${shortcutText("tui.select.confirm", keybindings)} to submit`)
			: theme.fg("warning", "Answer every question to submit"),
	);
}
