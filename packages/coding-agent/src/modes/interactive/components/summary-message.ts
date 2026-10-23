import { type Container, Markdown, type MarkdownTheme, Spacer, Text } from "@octocodeai/octocode-tui";
import { theme } from "../theme/theme.ts";
import { CollapsibleMessageComponent } from "./collapsible-message.ts";
import { keyText } from "./keybinding-hints.ts";

/** What a summary message shows: its `[label]`, one line while collapsed, and a heading over the Markdown summary. */
export interface SummaryMessageText {
	label: string;
	collapsed: string;
	heading: string;
	summary: string;
}

/** A labelled summary message (compaction, branch) collapsed to one line until clicked or expanded. */
export class SummaryMessageComponent extends CollapsibleMessageComponent {
	private readonly text: SummaryMessageText;
	private readonly markdownTheme: MarkdownTheme;

	constructor(text: SummaryMessageText, markdownTheme: MarkdownTheme, outputPad: number) {
		super(outputPad);
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	protected renderContent(content: Container, expanded: boolean): void {
		content.addChild(new Text(theme.fg("customMessageLabel", `\x1b[1m[${this.text.label}]\x1b[22m`), 0, 0));
		content.addChild(new Spacer(1));
		if (expanded) {
			content.addChild(
				new Markdown(`**${this.text.heading}**\n\n${this.text.summary}`, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			content.addChild(
				new Text(
					theme.fg("customMessageText", `${this.text.collapsed} (`) +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}
	}
}
