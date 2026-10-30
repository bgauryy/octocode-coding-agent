import { type Component, truncateToWidth } from "@octocodeai/octocode-tui";
import { isMcpToolName } from "../../../../../../mcp/src/servers.ts";
import { isNativeTool } from "../../../../octocode/permission/native-tools.ts";
import { callReason } from "../../../../octocode/shared/reason.ts";
import { isInformativeReason } from "../../../../octocode/shared/render/text.ts";
import { sanitizeTerminalText } from "../../../../octocode/shared/sanitize.ts";
import { theme } from "../../../../theme/theme.ts";

/** Aligned with the `⎿` of the result gutter, under the title. */
const INDENT = "  ";

/** One italic line in the `toolReason` color under a tool call, under its title like the `⎿` result gutter: the goal the model gave the call, cut to the row's width. */
class ReasonLine implements Component {
	private readonly text: string;
	constructor(reason: string) {
		this.text = `↳ ${sanitizeTerminalText(reason).replace(/\s+/g, " ").trim()}`;
	}
	render(width: number): string[] {
		return width > INDENT.length
			? [`${INDENT}${theme.italic(theme.fg("toolReason", truncateToWidth(this.text, width - INDENT.length)))}`]
			: [];
	}
	invalidate(): void {}
}

/**
 * The reason row for a tool call's arguments. Native tools take a `reason`; models add one to MCP calls too (the MCP
 * tool definition drops it before the server sees it, but the row shows the call as the model made it). Extension
 * tools define their own arguments, so a `reason` there may mean something else: no row. None either when the call
 * gives no reason or one too short to say more than the title (`Edit`).
 */
export function reasonRow(toolName: string, args: unknown): Component | undefined {
	const reason = isNativeTool(toolName) || isMcpToolName(toolName) ? callReason(args) : undefined;
	return isInformativeReason(reason) ? new ReasonLine(reason) : undefined;
}
