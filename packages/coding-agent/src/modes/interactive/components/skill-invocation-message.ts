import { type Container, Markdown, type MarkdownTheme, Text } from "@octocodeai/octocode-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { CollapsibleMessageComponent } from "./collapsible-message.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Renders a skill invocation block, collapsed to one line until clicked or expanded.
 * Only renders the skill block itself - user message is rendered separately.
 */
export class SkillInvocationMessageComponent extends CollapsibleMessageComponent {
	private readonly skillBlock: ParsedSkillBlock;
	private readonly markdownTheme: MarkdownTheme;

	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		super(outputPad);
		this.skillBlock = skillBlock;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	protected renderContent(content: Container, expanded: boolean): void {
		if (expanded) {
			content.addChild(new Text(theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m`), 0, 0));
			content.addChild(
				new Markdown(`**${this.skillBlock.name}**\n\n${this.skillBlock.content}`, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			content.addChild(
				new Text(
					theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
						theme.fg("customMessageText", this.skillBlock.name) +
						theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`),
					0,
					0,
				),
			);
		}
	}
}
