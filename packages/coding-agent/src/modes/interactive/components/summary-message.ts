import { Box, Container, Markdown, type MarkdownTheme, MouseRegion, Spacer, Text } from "@octocodeai/octocode-tui";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/** What a summary message shows: its `[label]`, one line while collapsed, and a heading over the Markdown summary. */
export interface SummaryMessageText {
	label: string;
	collapsed: string;
	heading: string;
	summary: string;
}

/**
 * A labelled summary message (compaction, branch) collapsed to one line until clicked or expanded. Uses the custom
 * message background for visual consistency.
 */
export class SummaryMessageComponent extends Box {
	private expanded = false;
	private readonly text: SummaryMessageText;
	private readonly markdownTheme: MarkdownTheme;

	constructor(text: SummaryMessageText, markdownTheme: MarkdownTheme, outputPad: number) {
		super(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.setPaddingX(outputPad);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const content = new Container();
		content.addChild(new Text(theme.fg("customMessageLabel", `\x1b[1m[${this.text.label}]\x1b[22m`), 0, 0));
		content.addChild(new Spacer(1));
		if (this.expanded) {
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
		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}
}
