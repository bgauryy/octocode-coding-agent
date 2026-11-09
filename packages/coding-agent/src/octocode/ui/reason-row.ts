import { type Component, truncateToWidth } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { theme } from "../../theme/theme.ts";
import { takesCallReason } from "../permission/native-tools.ts";
import { itemTitle, withItemTitles } from "../render/item-titles.ts";
import { purposeBlock } from "./purpose-block.ts";
import { callReasonText } from "./call-reason.ts";

/** Aligned with the `⎿` of the result gutter, under the title. */
const INDENT = "  ";

/** One italic line in the `toolReason` color under a tool call, under its title like the `⎿` result gutter: the goal the model gave the call, cut to the row's width. */
class ReasonLine implements Component {
	private readonly text: string;
	/** `ours`: the text is our own native call's reason, so a backlog ID in it is drawn with its title, once, when the row is built. A server's returned text is never decorated. */
	constructor(reason: string, ours: boolean) {
		const flat = sanitizeTerminalText(reason).replace(/\s+/g, " ").trim();
		this.text = `↳ ${ours ? withItemTitles(flat, itemTitle) : flat}`;
	}
	render(width: number): string[] {
		return width > INDENT.length
			? [`${INDENT}${theme.italic(theme.fg("toolReason", truncateToWidth(this.text, width - INDENT.length)))}`]
			: [];
	}
	invalidate(): void {}
}

/** The reason row of a tool call, shared by the terminal tool view and the HTML export (which receives it from the session, since `core/` cannot import the tool views). */
export function reasonRow(toolName: string, args: unknown, structuredContent?: unknown): Component | undefined {
	const reason = callReasonText(toolName, args, structuredContent);
	return reason === undefined ? undefined : new ReasonLine(reason, takesCallReason(toolName));
}

/**
 * The purpose block below a tool's result: what the result's own data states per query row, without the text the reason
 * row above already shows. The call's arguments only decide what that row shows; they are never displayed here.
 */
export function purposeRows(toolName: string, args: unknown, structuredContent?: unknown): Component | undefined {
	return purposeBlock(structuredContent, callReasonText(toolName, args, structuredContent));
}
