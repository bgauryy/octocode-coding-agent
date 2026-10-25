import { type Component, truncateToWidth } from "@octocodeai/octocode-tui";
import { isNativeTool } from "../../../../octocode/permission/native-tools.ts";
import { callReason } from "../../../../octocode/shared/reason.ts";
import { sanitizeTerminalText } from "../../../../octocode/shared/sanitize.ts";
import { theme } from "../../theme/theme.ts";

/** One muted, italic line under a native tool call: the goal the model gave the call, cut to the row's width. */
class ReasonLine implements Component {
	private readonly text: string;
	constructor(reason: string) {
		this.text = `↳ ${sanitizeTerminalText(reason).replace(/\s+/g, " ").trim()}`;
	}
	render(width: number): string[] {
		return width > 0 ? [theme.italic(theme.fg("muted", truncateToWidth(this.text, width)))] : [];
	}
	invalidate(): void {}
}

/** The reason row for a native tool call's arguments; none for other tools or when the call states no reason. */
export function reasonRow(toolName: string, args: unknown): Component | undefined {
	const reason = isNativeTool(toolName) ? callReason(args) : undefined;
	return reason ? new ReasonLine(reason) : undefined;
}
