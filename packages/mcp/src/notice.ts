import type { McpCommandContext } from "./host/types.ts";
import { sanitizeTerminalText } from "../../common/src/sanitize.ts";

/**
 * Shows `/mcp` output. With a UI it is a notification; print and JSON modes have none (`notify` does nothing there)
 * and keep stdout for the answer, so the text goes to stderr. Mirrors the host's native `say`, which this hosted
 * workspace may not import.
 */
export function say(
	ctx: Pick<McpCommandContext, "hasUI" | "ui">,
	text: string,
	level: "info" | "warning" | "error" = "info",
): void {
	const shown = sanitizeTerminalText(text);
	ctx.ui.notify(shown, level);
	if (!ctx.hasUI) process.stderr.write(`${shown}\n`);
}
