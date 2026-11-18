import type { KeybindingsManager } from "@octocodeai/octocode-tui";
import type { RankedHint } from "../../../theme/theme-tui-helpers.ts";
import { shortcutText } from "../../shared/keys.ts";

/** What the dialog's key hints depend on. `question` is undefined on the Submit tab. */
export interface HintState {
	typing: boolean;
	multi: boolean;
	/** The question's type, or undefined on the Submit tab. */
	question: "text" | "choice" | "multi" | "confirm" | "approval" | undefined;
	/** The card has a body or notes that `tab` would reveal. */
	more: boolean;
	expanded: boolean;
}

/** The ranked key hints under the card; `fitHints` drops the lowest ranks that do not fit. */
export function askHints(kb: KeybindingsManager, state: HintState): RankedHint[] {
	const confirm = shortcutText("tui.select.confirm", kb);
	const cancel = shortcutText("tui.select.cancel", kb);
	const { question } = state;
	if (state.typing)
		return [
			[shortcutText("tui.input.submit", kb), "submit", 0],
			[cancel, "back", 1],
		];
	return [
		...(state.multi
			? ([
					[`${shortcutText("app.ask.previous", kb)}/${shortcutText("app.ask.next", kb)}`, "questions", 3],
				] as RankedHint[])
			: []),
		...(question
			? ([
					[`${shortcutText("tui.select.up", kb)}/${shortcutText("tui.select.down", kb)}/1-9`, "move", 2],
				] as RankedHint[])
			: []),
		!question
			? [confirm, "submit", 0]
			: question === "multi"
				? [`${shortcutText("app.ask.toggle", kb)}/${confirm}`, "toggle", 0]
				: [confirm, "select", 0],
		...(question && !state.multi && state.more
			? ([[shortcutText("tui.input.tab", kb), state.expanded ? "less" : "show all", 4]] as RankedHint[])
			: []),
		[cancel, "cancel", 1],
	];
}
