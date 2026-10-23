import type { MarkdownTheme } from "@octocodeai/octocode-tui";
import type { BranchSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme } from "../theme/theme.ts";
import { SummaryMessageComponent } from "./summary-message.ts";

/** A branch summary message, collapsed to one line until expanded. */
export class BranchSummaryMessageComponent extends SummaryMessageComponent {
	constructor(message: BranchSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		super(
			{ label: "branch", collapsed: "Branch summary", heading: "Branch Summary", summary: message.summary },
			markdownTheme,
			outputPad,
		);
	}
}
