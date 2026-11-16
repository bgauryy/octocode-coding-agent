import { Spacer, ThemedText } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { theme } from "../../../theme/theme.ts";
import type { InteractiveModeHost } from "./host.ts";

type FooterStatusHost = Pick<InteractiveModeHost, "chatContainer" | "footerDataProvider" | "outputPad" | "ui">;

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
					...statuses.map(([key, entry]) => {
						const tone = entry.tone ?? "muted";
						const label = sanitizeTerminalText(key).replace(/\s+/g, " ").trim();
						const severity = tone === "warning" || tone === "error" ? `${tone.toUpperCase()} · ` : "";
						return theme.fg(tone, `${severity}${label}: ${sanitizeTerminalText(entry.text)}`);
					}),
				].join("\n"),
			host.outputPad,
			0,
		),
	);
	host.ui.requestRender();
}
