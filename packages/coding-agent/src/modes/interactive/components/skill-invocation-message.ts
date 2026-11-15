import {
	type Component,
	type Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	truncateToWidth,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { skillInstructions } from "../../../octocode/skill/render.ts";
import { shortPath } from "../../../utils/display-path.ts";
import { expandHint, plural } from "../../../octocode/shared/text.ts";
import { getMarkdownTheme, theme } from "../../../theme/theme.ts";
import { CollapsibleMessageComponent } from "./collapsible-message.ts";

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
		const hint = expanded ? "" : expandHint();
		content.addChild(
			new Text(
				theme.fg("customMessageLabel", `${theme.bold("[skill]")} `) +
					theme.fg("customMessageText", sanitizeTerminalText(name)) +
					theme.fg("dim", ` \u00b7 ${plural(lines, "line")}`),
				0,
				0,
			),
		);
		content.addChild(new ClippedLine(theme.fg("dim", sanitizeTerminalText(shortPath(location))), !expanded));
		if (hint) content.addChild(new Text(theme.fg("dim", hint), 0, 0));
		if (!expanded) return;
		content.addChild(new Spacer(1));
		content.addChild(
			new Markdown(sanitizeTerminalText(instructions), 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}
}

/** One line that is cut to the width when `clip` is set, and wraps whole otherwise (an expanded path is worth reading). */
class ClippedLine implements Component {
	private readonly text: string;
	private readonly clip: boolean;
	constructor(text: string, clip: boolean) {
		this.text = text;
		this.clip = clip;
	}
	render(width: number): string[] {
		return this.clip ? [truncateToWidth(this.text, width, "…")] : new Text(this.text, 0, 0).render(width);
	}
	invalidate(): void {}
}
