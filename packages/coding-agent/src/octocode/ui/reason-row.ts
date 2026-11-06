import { returnedPurpose } from "@octocodeai/octocode-contracts";
import { type Component, truncateToWidth } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { isMcpToolName } from "../../../../mcp/src/servers.ts";
import { theme } from "../../theme/theme.ts";
import { takesCallReason } from "../permission/native-tools.ts";
import { callReason } from "../shared/reason.ts";
import { itemTitle, withItemTitles } from "../shared/render/item-titles.ts";
import { isInformativeReason } from "../shared/render/text.ts";
import { purposeBlock } from "./purpose-block.ts";

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

/**
 * The text a tool call's one-line reason states. Native tools and the `mcp` tool require a `reason`, read from the
 * call's arguments. An MCP tool's input belongs to its server, so its line shows only the goal or reason the server's
 * returned data states (`returnedPurpose` of the result's `structuredContent`), never one from the arguments. Extension
 * tools define their own arguments, so a `reason` there may mean something else: none. None either when there is no
 * reason or one too short to say more than the title (`Edit`).
 */
export function callReasonText(toolName: string, args: unknown, structuredContent?: unknown): string | undefined {
	const reason = takesCallReason(toolName)
		? callReason(args)
		: isMcpToolName(toolName)
			? returnedPurpose(structuredContent)
			: undefined;
	return isInformativeReason(reason) ? reason : undefined;
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
