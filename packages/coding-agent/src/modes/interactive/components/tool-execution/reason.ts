import { type Component, truncateToWidth } from "@octocodeai/octocode-tui";
import { isNativeTool } from "../../../../octocode/permission/native-tools.ts";
import { callReason } from "../../../../octocode/shared/reason.ts";
import { isInformativeReason } from "../../../../octocode/shared/render/text.ts";
import { sanitizeTerminalText } from "../../../../octocode/shared/sanitize.ts";
import { theme } from "../../../../theme/theme.ts";

/** Aligned with the `⎿` of the result gutter, under the title. */
const INDENT = "  ";

/** One muted, italic line under a native tool call, under its title like the `⎿` result gutter: the goal the model gave the call, cut to the row's width. */
class ReasonLine implements Component {
	private readonly text: string;
	constructor(reason: string) {
		this.text = `↳ ${sanitizeTerminalText(reason).replace(/\s+/g, " ").trim()}`;
	}
	render(width: number): string[] {
		return width > INDENT.length
			? [`${INDENT}${theme.italic(theme.fg("muted", truncateToWidth(this.text, width - INDENT.length)))}`]
			: [];
	}
	invalidate(): void {}
}

/** The reason row for a native tool call's arguments; none for other tools, or when the call gives no reason or one too short to say more than the title (`Edit`). */
export function reasonRow(toolName: string, args: unknown): Component | undefined {
	const reason = isNativeTool(toolName) ? callReason(args) : undefined;
	return isInformativeReason(reason) ? new ReasonLine(reason) : undefined;
}
