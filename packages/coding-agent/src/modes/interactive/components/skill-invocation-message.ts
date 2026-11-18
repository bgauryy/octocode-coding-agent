import { type Container, Markdown, type MarkdownTheme, Spacer } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { skillInstructions } from "../../../octocode/skill/render.ts";
import { shortPath } from "../../../utils/display-path.ts";
import { expandHint, plural } from "../../../octocode/shared/text.ts";
import { getMarkdownTheme, theme } from "../../../theme/theme.ts";
import { CollapsibleMessageComponent } from "./collapsible-message.ts";
import { MessageHead } from "./message-head.ts";

/**
 * Renders a skill invocation block (`/skill:name`): `[skill] name · N lines · <file>` on one row where it fits, and the
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
		const hint = expanded ? "" : expandHint();
		const head =
			theme.fg("customMessageLabel", `${theme.bold("[skill]")} `) +
			theme.fg("customMessageText", sanitizeTerminalText(name)) +
			theme.fg("dim", ` \u00b7 ${plural(lines, "line")}`);
		// Collapsed, a path too long for its row is cut to the width; expanded, it wraps whole (it is worth reading).
		const path = theme.fg("dim", sanitizeTerminalText(shortPath(location)));
		content.addChild(new MessageHead(head, hint, path, !expanded));
		if (!expanded) return;
		content.addChild(new Spacer(1));
		content.addChild(
			new Markdown(sanitizeTerminalText(instructions), 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}
}
