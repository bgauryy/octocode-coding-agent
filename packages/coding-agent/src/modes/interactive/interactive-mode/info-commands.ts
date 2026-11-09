/**
 * Slash commands that show information: /session, /changelog, /hotkeys and /debug.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type Keybinding, Markdown, Spacer, visibleWidth } from "@octocodeai/octocode-tui";
import { atomicWriteFileSync } from "../../../../../common/src/atomic-file.ts";
import { PRIVATE_FILE_MODE } from "../../../../../common/src/file-mode.ts";
import { redactSecrets } from "../../../../../common/src/sanitize.ts";
import { getDebugLogPath } from "../../../config.ts";
import { describeCachePolicy } from "../../../core/cache-configuration.ts";
import { formatCacheWarmingStatus } from "../../../core/cache-warmer.ts";
import type { AppKeybinding } from "../../../core/keybindings.ts";
import { formatSessionReport } from "../../../octocode/shared/session-report.ts";
import { getChangelogPath, normalizeChangelogLinks, parseChangelog } from "../../../utils/changelog.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { formatKeyText, keyText } from "../components/keybinding-hints.ts";
import { ThemedText } from "../components/themed-text.ts";
import { theme } from "../../../theme/theme.ts";
import { noticeLine } from "./display.ts";
import { formatResumeCommand } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the informational slash commands. */
type InfoCommandsHost = Pick<
	InteractiveModeHost,
	| "chatContainer"
	| "getAppKeyDisplay"
	| "getMarkdownThemeWithSettings"
	| "keybindings"
	| "outputPad"
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
	const cacheWarmingStatus = host.session.cacheWarmingStatus;
	const cacheWarmingMode = host.settingsManager.getCacheWarmingMode();
	const model = host.session.model;
	const resumeCommand = formatResumeCommand(host.sessionManager);
	const renderInfo = (): string => {
		let warming = `${theme.bold("Cache Warming")}\n`;
		if (model)
			warming += `${describeCachePolicy(model, host.session.modelRuntime.getCachePolicy(model, undefined, host.settingsManager.getCachePreferenceLayers()), host.session.modelRuntime.isUsingSubscription(model.provider))}\n`;
		warming += `${theme.fg("dim", "Mode:")} ${cacheWarmingMode}\n`;
		warming += `${theme.fg("dim", "Status:")} ${cacheWarmingStatus ? formatCacheWarmingStatus(cacheWarmingStatus) : "Inactive (cache warming unavailable)"}\n`;
		const decision = cacheWarmingStatus?.decision;
		if (decision?.economicsAvailable) {
			warming += `${theme.fg("dim", "Estimated cache miss penalty:")} $${decision.missCost.toFixed(3)}\n`;
			warming += `${theme.fg("dim", "Estimated refresh cost:")} $${decision.warmCost.toFixed(3)}\n`;
		}
		return formatSessionReport(
			{
				stats,
				entries,
				prices: host.session.modelRuntime,
				selectedModelKey: `${model?.provider}/${model?.id}`,
				name: sessionName,
				resumeCommand,
				afterCache: warming,
			},
			{ bold: (text) => theme.bold(text), dim: (text) => theme.fg("dim", text) },
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

/**
 * Get the display string for an editor keybinding action.
 */
function getEditorKeyDisplay(action: Keybinding): string {
	return keyText(action);
}

export function handleHotkeysCommand(host: InfoCommandsHost): void {
	// Navigation keybindings
	const cursorUp = getEditorKeyDisplay("tui.editor.cursorUp");
	const cursorDown = getEditorKeyDisplay("tui.editor.cursorDown");
	const cursorLeft = getEditorKeyDisplay("tui.editor.cursorLeft");
	const cursorRight = getEditorKeyDisplay("tui.editor.cursorRight");
	const cursorWordLeft = getEditorKeyDisplay("tui.editor.cursorWordLeft");
	const cursorWordRight = getEditorKeyDisplay("tui.editor.cursorWordRight");
	const cursorLineStart = getEditorKeyDisplay("tui.editor.cursorLineStart");
	const cursorLineEnd = getEditorKeyDisplay("tui.editor.cursorLineEnd");
	const jumpForward = getEditorKeyDisplay("tui.editor.jumpForward");
	const jumpBackward = getEditorKeyDisplay("tui.editor.jumpBackward");
	const pageUp = getEditorKeyDisplay("tui.editor.pageUp");
	const pageDown = getEditorKeyDisplay("tui.editor.pageDown");

	// Editing keybindings
	const submit = getEditorKeyDisplay("tui.input.submit");
	const newLine = getEditorKeyDisplay("tui.input.newLine");
	const deleteWordBackward = getEditorKeyDisplay("tui.editor.deleteWordBackward");
	const deleteWordForward = getEditorKeyDisplay("tui.editor.deleteWordForward");
	const deleteToLineStart = getEditorKeyDisplay("tui.editor.deleteToLineStart");
	const deleteToLineEnd = getEditorKeyDisplay("tui.editor.deleteToLineEnd");
	const yank = getEditorKeyDisplay("tui.editor.yank");
	const yankPop = getEditorKeyDisplay("tui.editor.yankPop");
	const undo = getEditorKeyDisplay("tui.editor.undo");
	const tab = getEditorKeyDisplay("tui.input.tab");

	// App keybindings
	const interrupt = host.getAppKeyDisplay("app.interrupt");
	const clear = host.getAppKeyDisplay("app.clear");
	const exit = host.getAppKeyDisplay("app.exit");
	const suspend = host.getAppKeyDisplay("app.suspend");
	const cycleThinkingLevel = host.getAppKeyDisplay("app.thinking.cycle");
	const cycleModelForward = host.getAppKeyDisplay("app.model.cycleForward");
	const selectModel = host.getAppKeyDisplay("app.model.select");
	const expandTools = host.getAppKeyDisplay("app.tools.expand");
	const toggleThinking = host.getAppKeyDisplay("app.thinking.toggle");
	const externalEditor = host.getAppKeyDisplay("app.editor.external");
	const cycleModelBackward = host.getAppKeyDisplay("app.model.cycleBackward");
	const copyMessage = host.getAppKeyDisplay("app.message.copy");
	const followUp = host.getAppKeyDisplay("app.message.followUp");
	const dequeue = host.getAppKeyDisplay("app.message.dequeue");
	const pasteImage = host.getAppKeyDisplay("app.clipboard.pasteImage");

	let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (ctrl+enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${copyMessage}\` | Copy selection or last assistant message |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore the last queued message (\`/queue\` manages all) |
| \`${pasteImage}\` | Paste files on macOS, images, or text from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

	// Add extension-registered shortcuts
	const extensionRunner = host.session.extensionRunner;
	const shortcuts = extensionRunner.getShortcuts(host.keybindings.getEffectiveConfig());
	if (shortcuts.size > 0) {
		hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
		for (const [key, shortcut] of shortcuts) {
			const description = shortcut.description ?? shortcut.extensionPath;
			const keyDisplay = formatKeyText(key);
			hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
		}
	}

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

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(noticeLine("success", "Debug log written", host.outputPad));
	host.chatContainer.addChild(new ThemedText(() => `  ${theme.fg("muted", debugLogPath)}`, host.outputPad, 0));
	host.ui.requestRender();
}
