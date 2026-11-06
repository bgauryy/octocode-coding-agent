import { hostPaths } from "./host.ts";
import type { McpCommandContext, McpContext } from "./host/types.ts";
import { untrustedProjectNote } from "./inspection.ts";
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

/** Tells the user, once per call, that an untrusted folder's project MCP files were not loaded; silent when trusted or absent. */
export function sayUntrustedProject(ctx: McpContext): void {
	const note = untrustedProjectNote(hostPaths().agentDir(), ctx.cwd, ctx.isProjectTrusted());
	if (note) say(ctx, note, "warning");
}
