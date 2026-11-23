import { GLYPH, Spacer, ThemedText } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { theme } from "../../../theme/theme.ts";
import type { InteractiveModeHost } from "./host.ts";

type FooterStatusHost = Pick<InteractiveModeHost, "chatContainer" | "footerDataProvider" | "ui" | "uiStore">;

/** A status key as a reader names it: `octocode-backlog` reads `backlog`; the `octocode-` prefix is the owner's. */
const statusLabel = (key: string): string =>
	sanitizeTerminalText(key)
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^octocode-/, "");

/**
 * One status as a line: the mark and word of its state (`⚠`, `✗`) in its tone, then its label and text. A text that
 * names itself (`⏵⏵ permission: full`) is not labelled again.
 */
export function statusReportLine(key: string, entry: { text: string; tone?: string }): string {
	const text = sanitizeTerminalText(entry.text);
	const label = statusLabel(key);
	const named = text.toLowerCase().includes(`${label.toLowerCase()}:`);
	// The word as well as the mark, so the severity survives copying, screen readers and terminals without colour.
	const mark =
		entry.tone === "error" ? `${GLYPH.failed} ERROR · ` : entry.tone === "warning" ? `${GLYPH.warning} WARNING · ` : "";
	return `${mark}${named || !label ? "" : `${label}: `}${text}`;
}

/** Keep complete status details in the transcript when the compact footer cannot show them. */
export function showFooterStatusReport(host: FooterStatusHost): void {
	const statuses = [...(host.footerDataProvider?.getState().statuses ?? [])];
	if (statuses.length === 0) return;
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(
		new ThemedText(
			() =>
				[
					theme.bold("Live status"),
					...statuses.map(([key, entry]) => theme.fg(entry.tone ?? "muted", statusReportLine(key, entry))),
				].join("\n"),
			host.uiStore.getState().view.outputPad,
			0,
		),
	);
	host.ui.requestRender();
}
