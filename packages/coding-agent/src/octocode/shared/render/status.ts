import type { ExtensionContext } from "../../../core/extensions/index.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ColorToken } from "./types.ts";

/** What `statusColor` painted, by its output, so the footer can repaint it in the live theme (`livePaint`). */
const painted = new Map<string, { color: ColorToken; text: string }>();
/** Bounded: counts in statuses change; a status evicted while still shown keeps its colours until the next theme switch. */
const PAINTED_MAX = 64;

/**
 * A coloured footer status in the TUI; plain text for RPC clients, which would otherwise receive raw escape codes.
 * The footer repaints it with the theme of each frame, so a theme switch reaches statuses set before it.
 */
export function statusColor(ctx: Pick<ExtensionContext, "mode" | "ui">, color: ColorToken, text: string): string {
	if (ctx.mode !== "tui") return text;
	const out = ctx.ui.theme.fg(color, text);
	painted.delete(out);
	painted.set(out, { color, text });
	if (painted.size > PAINTED_MAX) painted.delete(painted.keys().next().value!);
	return out;
}

/** A status `statusColor` made, painted again with `theme` (the live one); any other text as it is. */
export function livePaint(text: string, theme: Pick<Theme, "fg">): string {
	const entry = painted.get(text);
	return entry ? theme.fg(entry.color, entry.text) : text;
}
