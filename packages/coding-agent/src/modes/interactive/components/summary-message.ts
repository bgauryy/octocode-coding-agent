import { type Container, Markdown, type MarkdownTheme, Spacer, Text, type TUI } from "@octocodeai/octocode-tui";
import { MessageHead } from "./message-head.ts";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { theme } from "../../../theme/theme.ts";
import { CollapsibleMessageComponent } from "./collapsible-message.ts";
import { expandHint } from "../../../octocode/shared/text.ts";

/** What a summary message shows. Every string is untrusted text: it is sanitized where drawn. */
export interface SummaryMessageText {
	label: string;
	/** The line after the `[label]`. */
	title: string;
	/** Dim lines under the title, collapsed and expanded: where the full record lives. */
	meta?: string[];
	/** Markdown shown only when expanded. */
	summary: string;
	/** Dim lines after the summary, only when expanded. */
	appendix?: string[];
}

/** A labelled summary message (compaction, branch) collapsed to its title and record lines until clicked or expanded. */
export class SummaryMessageComponent extends CollapsibleMessageComponent {
	private readonly text: SummaryMessageText;
	private readonly markdownTheme: MarkdownTheme;

	constructor(
		text: SummaryMessageText,
		markdownTheme: MarkdownTheme,
		outputPad: number,
		ui?: Pick<TUI, "keepScrollbackOnCollapse">,
	) {
		super(outputPad, ui);
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	protected renderContent(content: Container, expanded: boolean): void {
		const { label, title, meta = [], summary, appendix = [] } = this.text;
		const hint = expanded ? "" : expandHint();
		const dim = (line: string) => theme.fg("dim", sanitizeTerminalText(line));
		const head =
			theme.fg("customMessageLabel", theme.bold(`[${label}]`)) +
			` ${theme.fg("customMessageText", sanitizeTerminalText(title))}`;
		// The hint joins the title when the row fits it, else takes a row of its own.
		content.addChild(new MessageHead(head, hint));
		for (const line of meta) content.addChild(new Text(dim(line), 0, 0));
		if (!expanded) return;
		if (summary.trim() !== "") {
			content.addChild(new Spacer(1));
			content.addChild(
				new Markdown(sanitizeTerminalText(summary), 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		}
		if (appendix.length > 0) {
			content.addChild(new Spacer(1));
			for (const line of appendix) content.addChild(new Text(dim(line), 0, 0));
		}
	}
}
