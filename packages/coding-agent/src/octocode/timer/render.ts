import type { Component } from "@octocodeai/octocode-tui";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import type { Theme } from "../../theme/theme.ts";
import { textBlock } from "../render/tool.ts";
import { clip } from "../shared/text.ts";
import type { TimerWakeDetails } from "./model.ts";

const clean = (text: string, max: number) => clip(sanitizeTerminalText(text), max);

/**
 * A timer's wake in the chat: a notice in the theme's warning colour (yellow in the default themes), set apart from
 * tool rows and replies. It names the timer and why it fired, then the note; the last check's result shows expanded,
 * or its first line collapsed.
 */
export function renderTimerMessage(
	details: unknown,
	text: string,
	expanded: boolean,
	theme: Theme,
	outputPad = 1,
): Component {
	if (!isRecord(details) || typeof details.id !== "number")
		return textBlock(theme.fg("warning", `⏰ ${clean(text, 400)}`), outputPad);
	const wake = details as unknown as TimerWakeDetails;
	const ended = wake.status === "active" ? "" : ` · ${wake.status}`;
	const lines = [
		theme.fg("warning", theme.bold(`⏰ Wait ${wake.id}: ${clean(wake.reason, 200)}${ended}`)),
		theme.fg("warning", `  ${clean(wake.note, expanded ? 2000 : 200)}`),
	];
	const output = wake.output?.trim();
	if (output || wake.exit !== null) {
		const exit = wake.exit !== null ? `exit ${wake.exit}: ` : "";
		const shown = expanded ? (output ?? "") : (output?.split("\n", 1)[0] ?? "");
		lines.push(theme.fg("dim", `  ${exit}${clean(shown, expanded ? 2000 : 160)}`));
	}
	return textBlock(lines.join("\n"), outputPad);
}
