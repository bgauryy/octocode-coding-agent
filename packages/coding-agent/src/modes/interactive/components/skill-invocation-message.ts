import { type Container, Markdown, type MarkdownTheme, Spacer, Text } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { skillInstructions } from "../../../octocode/skill/render.ts";
import { shortPath } from "../../../octocode/shared/format.ts";
import { plural } from "../../../octocode/shared/render/text.ts";
import { getMarkdownTheme, theme } from "../../../theme/theme.ts";
import { CollapsibleMessageComponent } from "./collapsible-message.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Renders a skill invocation block (`/skill:name`): `[skill] name · N lines`, the instruction file under it, and the
 * instructions themselves once expanded. Only the skill block is drawn here; the user's own message is rendered separately.
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
		const { name, location } = this.skillBlock;
		const instructions = skillInstructions(this.skillBlock.content);
		const lines = instructions.split("\n").length;
		const hint = expanded ? "" : theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
		content.addChild(
			new Text(
				theme.fg("customMessageLabel", `${theme.bold("[skill]")} `) +
					theme.fg("customMessageText", sanitizeTerminalText(name)) +
					theme.fg("dim", ` \u00b7 ${plural(lines, "line")}`),
				0,
				0,
			),
		);
		content.addChild(new Text(theme.fg("dim", sanitizeTerminalText(shortPath(location))) + hint, 0, 0));
		if (!expanded) return;
		content.addChild(new Spacer(1));
		content.addChild(
			new Markdown(sanitizeTerminalText(instructions), 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}
}
