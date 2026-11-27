import { GLYPH, type MarkdownTheme, type TUI } from "@octocodeai/octocode-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { keptLine, viewSummary } from "../../../core/compaction/summary-view.ts";
import { formatTokens } from "../../../octocode/shared/format.ts";
import { shortPath } from "../../../utils/display-path.ts";
import { clip, plural } from "../../../octocode/shared/text.ts";
import { getMarkdownTheme } from "../../../theme/theme.ts";
import { SummaryMessageComponent, type SummaryMessageText } from "./summary-message.ts";

/** What a compaction message says: the tokens summarized and the summary's size, where the full record is, the kept user messages. */
function compactionText(message: CompactionSummaryMessage): SummaryMessageText {
	const view = viewSummary(message.summary);
	const kept = view.messages.length;
	// The best record leads and shows while collapsed; the fallbacks follow the summary once expanded.
	const records = [
		...(view.archive ? [`archive: segment ${view.archive.segment} \u00b7 ${shortPath(view.archive.folder)}`] : []),
		...(view.checkpointFile ? [`checkpoint: ${shortPath(view.checkpointFile)}`] : []),
		...(view.transcript ? [`transcript: ${shortPath(view.transcript)}`] : []),
	];
	return {
		label: "compaction",
		title: `${formatTokens(message.tokensBefore)} tokens ${GLYPH.arrow} ${formatTokens(view.summaryTokens)}-token summary`,
		meta: records.slice(0, 1),
		summary: view.body,
		appendix: [
			...records.slice(1),
			...(kept > 0
				? [
						`Kept ${plural(kept, "user message")} word for word${view.omitted > 0 ? `; ${view.omitted} earlier not kept` : ""}:`,
						...view.messages.map((text) => `- ${clip(keptLine(text), Number.MAX_SAFE_INTEGER)}`),
					]
				: []),
		],
	};
}

/** A compaction message, collapsed to its token count and where the full record lives until expanded. */
export class CompactionSummaryMessageComponent extends SummaryMessageComponent {
	constructor(
		message: CompactionSummaryMessage,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		ui?: Pick<TUI, "keepScrollbackOnCollapse">,
	) {
		super(compactionText(message), markdownTheme, outputPad, ui);
	}
}
