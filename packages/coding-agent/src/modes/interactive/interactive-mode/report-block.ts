import { Markdown, Spacer } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { ThemedText } from "../components/themed-text.ts";
import type { InteractiveModeHost } from "./host.ts";

type Host = Pick<InteractiveModeHost, "chatContainer" | "getMarkdownThemeWithSettings" | "ui">;

/** A titled Markdown block in the message list whose text can change after it was added. */
export interface ReportBlock {
	update(text: string): void;
}

/** Append a report to the conversation, like /changelog; later `update` calls replace its text in place. */
export function appendReport(host: Host, title: string, text: string): ReportBlock {
	const body = new Markdown("", 1, 1, host.getMarkdownThemeWithSettings());
	const update = (next: string): void => {
		body.setText(sanitizeTerminalText(next));
		host.ui.requestRender();
	};
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new DynamicBorder());
	host.chatContainer.addChild(new ThemedText(() => theme.bold(theme.fg("accent", title)), 1, 0));
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(body);
	host.chatContainer.addChild(new DynamicBorder());
	update(text);
	return { update };
}
