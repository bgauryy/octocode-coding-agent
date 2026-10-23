import type { MarkdownTheme } from "@octocodeai/octocode-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme } from "../theme/theme.ts";
import { SummaryMessageComponent } from "./summary-message.ts";

/** A compaction message, collapsed to its token count until expanded. */
export class CompactionSummaryMessageComponent extends SummaryMessageComponent {
	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		const tokens = `Compacted from ${message.tokensBefore.toLocaleString()} tokens`;
		super(
			{ label: "compaction", collapsed: tokens, heading: tokens, summary: message.summary },
			markdownTheme,
			outputPad,
		);
	}
}
