/**
 * Slash commands that show information: /session, /changelog, /hotkeys and /debug.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Markdown, Spacer, ThemedText, TuiAltScreen, visibleWidth } from "@octocodeai/octocode-tui";
import { atomicWriteFileSync } from "@octocodeai/octocode-common/atomic-file";
import { PRIVATE_FILE_MODE } from "@octocodeai/octocode-common/file-mode";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { getDebugLogPath } from "../../../config.ts";
import { cacheWarmingReport } from "../../../core/cache-warmer/report.ts";
import type { AppKeybinding } from "../../../core/keybindings.ts";
import { formatSessionReport } from "../../../octocode/shared/session-report.ts";
import { getChangelogPath, normalizeChangelogLinks, parseChangelog } from "../../../utils/changelog.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { keyText } from "../../../theme/theme-tui-helpers.ts";
import { theme } from "../../../theme/theme.ts";
import { noticeLine } from "./display.ts";
import { formatResumeCommand } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import { hotkeysMarkdown } from "./hotkeys-table.ts";

/** Interactive-mode members used by the informational slash commands. */
type InfoCommandsHost = Pick<
	InteractiveModeHost,
	| "chatContainer"
	| "getMarkdownThemeWithSettings"
	| "keybindings"
	| "uiStore"
	| "session"
	| "sessionManager"
	| "settingsManager"
	| "ui"
>;

export function handleSessionCommand(host: InfoCommandsHost): void {
	// Snapshot the stats; the text is built on demand so it follows theme changes.
	const stats = host.session.getSessionStats();
	const sessionName = host.sessionManager.getSessionName();
	const entries = host.sessionManager.getEntries();
	const model = host.session.model;
	const resumeCommand = formatResumeCommand(host.sessionManager);
	// The warmer's status as of the command; the session's getters are read here, not copied by a spread.
	const warmingSource = {
		model,
		cacheWarmingStatus: host.session.cacheWarmingStatus,
		modelRuntime: host.session.modelRuntime,
		settingsManager: host.settingsManager,
	};
	const style = { bold: (text: string) => theme.bold(text), dim: (text: string) => theme.fg("dim", text) };
	const renderInfo = (): string => {
		const warming = `${cacheWarmingReport(warmingSource, style).join("\n")}\n`;
		return formatSessionReport(
			{
				stats,
				entries,
				branch: host.sessionManager.getBranch(),
				prices: host.session.modelRuntime,
				selectedModelKey: `${model?.provider}/${model?.id}`,
				name: sessionName,
				resumeCommand,
				afterCache: warming,
			},
			style,
		);
	};

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new ThemedText(renderInfo, 1, 0));
	host.ui.requestRender();
}

export function handleChangelogCommand(host: InfoCommandsHost): void {
	const changelogPath = getChangelogPath();
	const allEntries = parseChangelog(changelogPath);

	const changelogMarkdown =
		allEntries.length > 0
			? allEntries
					.reverse()
					.map((e) => normalizeChangelogLinks(e.content, e))
					.join("\n\n")
			: "No changelog entries found.";

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new DynamicBorder());
	host.chatContainer.addChild(new ThemedText(() => theme.bold(theme.fg("accent", "What's New")), 1, 0));
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, host.getMarkdownThemeWithSettings()));
	host.chatContainer.addChild(new DynamicBorder());
	host.ui.requestRender();
}

/**
 * Get the display string for an app keybinding action.
 */
export function getAppKeyDisplay(action: AppKeybinding): string {
	return keyText(action);
}

export function handleHotkeysCommand(host: InfoCommandsHost): void {
	const hotkeys = hotkeysMarkdown({ key: keyText, fullscreen: host.ui instanceof TuiAltScreen });

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new DynamicBorder());
	host.chatContainer.addChild(new ThemedText(() => theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, host.getMarkdownThemeWithSettings()));
	host.chatContainer.addChild(new DynamicBorder());
	host.ui.requestRender();
}

export function handleDebugCommand(host: InfoCommandsHost): void {
	const width = host.ui.terminal.columns;
	const height = host.ui.terminal.rows;
	const allLines = host.ui.render(width);

	const debugLogPath = getDebugLogPath();
	const debugData = [
		`Debug output at ${new Date().toISOString()}`,
		`Terminal: ${width}x${height}`,
		`Total lines: ${allLines.length}`,
		"",
		"=== All rendered lines with visible widths ===",
		...allLines.map((line, idx) => {
			const vw = visibleWidth(line);
			const escaped = JSON.stringify(line);
			return `[${idx}] (w=${vw}) ${escaped}`;
		}),
		"",
		"=== Agent messages (JSONL) ===",
		...host.session.messages.map((msg) => JSON.stringify(msg)),
		"",
	].join("\n");

	// The log holds the whole screen and every message: owner-only, credentials redacted, replaced atomically so a
	// pre-existing permissive file does not keep its mode.
	fs.mkdirSync(path.dirname(debugLogPath), { recursive: true, mode: 0o700 });
	atomicWriteFileSync(debugLogPath, redactSecrets(debugData), { mode: PRIVATE_FILE_MODE });

	const pad = host.uiStore.getState().view.outputPad;
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(noticeLine("success", "Debug log written", pad));
	host.chatContainer.addChild(new ThemedText(() => `  ${theme.fg("muted", debugLogPath)}`, pad, 0));
	host.ui.requestRender();
}
