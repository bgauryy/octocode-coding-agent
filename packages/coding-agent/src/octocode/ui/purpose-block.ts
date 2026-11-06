import { layoutPurposes, returnedPurposes } from "@octocodeai/octocode-contracts";
import { type Component, truncateToWidth } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { theme } from "../../theme/theme.ts";

const INDENT = "  ";
/** Lines shown before the rest fold into `… +N more`. */
const MAX_LINES = 6;

interface PurposeLine {
	text: string;
	/** Reasoning reads italic; a goal reads upright. */
	italic: boolean;
}

const clean = (text: string): string => sanitizeTerminalText(text).replace(/\s+/g, " ").trim();

/** The lines of a purpose block, from the purposes a result returned. Pure in (result, shown). */
function purposeLines(structuredContent: unknown, shown: string | undefined): PurposeLine[] {
	const layout = layoutPurposes(returnedPurposes(structuredContent), shown);
	const lines: PurposeLine[] = [];
	if (layout.goal) lines.push({ text: `◎ ${clean(layout.goal)}`, italic: false });
	for (const row of layout.rows) {
		const label = layout.numbered && row.row !== undefined ? `#${row.row} ` : "";
		if (layout.shared) lines.push({ text: `${INDENT}· ${label}${clean(row.reasoning ?? "")}`, italic: true });
		else {
			const body = [row.mainGoal, row.reasoning].flatMap((part) => (part ? [clean(part)] : [])).join(" — ");
			lines.push({ text: `${label}${body}`, italic: !row.mainGoal });
		}
	}
	return lines;
}

/** The block under a tool result: every goal and reasoning the result's own data states, one line each, in the `toolReason` color. */
class PurposeBlock implements Component {
	private readonly lines: PurposeLine[];
	constructor(lines: PurposeLine[]) {
		this.lines = lines;
	}
	render(width: number): string[] {
		const room = width - INDENT.length;
		if (room <= 0) return [];
		const paint = (line: PurposeLine) => {
			const colored = theme.fg("toolReason", truncateToWidth(line.text, room));
			return `${INDENT}${line.italic ? theme.italic(colored) : colored}`;
		};
		const shown = this.lines.slice(0, MAX_LINES).map(paint);
		const more = this.lines.length - MAX_LINES;
		return more > 0 ? [...shown, `${INDENT}${theme.italic(theme.fg("muted", `… +${more} more`))}`] : shown;
	}
	invalidate(): void {}
}

/**
 * The purpose block of a tool result: one `◎` goal when every row shares it with a `·` reasoning per row, else a line per
 * row (`#row goal — reasoning`). Read only from the result's own data (never the call's arguments), whatever the tool;
 * `shown` is the text the tool row already draws as its one-line reason, which is not repeated. Undefined when nothing
 * is left to say.
 */
export function purposeBlock(structuredContent: unknown, shown?: string): Component | undefined {
	const lines = purposeLines(structuredContent, shown);
	return lines.length ? new PurposeBlock(lines) : undefined;
}
