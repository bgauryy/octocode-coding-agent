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
import { computeCacheWaste } from "../../../core/cache-stats.ts";
import { formatCacheWarmingStatus } from "../../../core/cache-warmer.ts";
import type { AppKeybinding } from "../../../core/keybindings.ts";
import { getUsageCostBreakdown } from "../../../core/usage-totals.ts";
import { formatTokens } from "../../../octocode/shared/format.ts";
import { getChangelogPath, normalizeChangelogLinks, parseChangelog } from "../../../utils/changelog.ts";
import { DynamicBorder } from "../components/dynamic-border.ts";
import { formatKeyText, keyText } from "../components/keybinding-hints.ts";
import { ThemedText } from "../components/themed-text.ts";
import { theme } from "../../../theme/theme.ts";
import { noticeLine } from "./display.ts";
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
	const stats = host.session.getSessionStats();
	const sessionName = host.sessionManager.getSessionName();
	const entries = host.sessionManager.getEntries();
	const cacheWaste = computeCacheWaste(entries, host.session.modelRuntime);

	// Cost/token totals per provider/model actually used (e.g. OpenRouter `auto`
	// resolves to a concrete responseModel). Usage without model attribution is
	// grouped separately so the breakdown reconciles with the session total.
	const usageBreakdown = getUsageCostBreakdown(entries);

	// Snapshot the stats; the text is built on demand so it follows theme changes.
	const cacheWarmingStatus = host.session.cacheWarmingStatus;
	const cacheWarmingMode = host.settingsManager.getCacheWarmingMode();
	const model = host.session.model;
	const selectedModelKey = `${model?.provider}/${model?.id}`;
	const renderInfo = (): string => {
		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tools:")} ${stats.toolCalls} calls, ${stats.toolResults} results\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		// "Input" is the full prompt volume. With cache activity, split it into
		// cached (served from cache) vs uncached (everything else) - the only
		// provider-independent split. Cache writes, where reported, are a detail
		// of the uncached portion.
		const { input, cacheRead, cacheWrite } = stats.tokens;
		const promptTokens = input + cacheRead + cacheWrite;
		info += `${theme.fg("dim", "Input:")} ${promptTokens.toLocaleString()}\n`;
		if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
			const hitRate = theme.fg("dim", `(${((cacheRead / promptTokens) * 100).toFixed(1)}%)`);
			info += `  ${theme.fg("dim", "Cached:")} ${cacheRead.toLocaleString()} ${hitRate}\n`;
			const written = cacheWrite > 0 ? ` ${theme.fg("dim", `(${cacheWrite.toLocaleString()} written to cache)`)}` : "";
			info += `  ${theme.fg("dim", "Uncached:")} ${(input + cacheWrite).toLocaleString()}${written}\n`;
		}
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;
		if (stats.thinkingReduced > 0) {
			info += `${theme.fg("dim", "Thinking budget reduced:")} ${stats.thinkingReduced} requests\n`;
		}

		const conversationCache = stats.cache.conversation;
		info += `${theme.fg("dim", "Conversation cache hits:")} ${conversationCache.hitRate === null ? "Unknown" : `${(conversationCache.hitRate * 100).toFixed(1)}%`} (${conversationCache.requests} requests)\n`;
		const refreshUsage = stats.cache.warming;
		info += `${theme.fg("dim", "Recorded refresh usage:")} ${refreshUsage.requests} requests, $${refreshUsage.cost.toFixed(3)}\n`;

		info += `\n${theme.bold("Cache Warming")}\n`;
		if (model)
			info += `${describeCachePolicy(model, host.session.modelRuntime.getCachePolicy(model, undefined, host.settingsManager.getCachePreferenceLayers()), host.session.modelRuntime.isUsingSubscription(model.provider))}\n`;
		info += `${theme.fg("dim", "Mode:")} ${cacheWarmingMode}\n`;
		info += `${theme.fg("dim", "Status:")} ${cacheWarmingStatus ? formatCacheWarmingStatus(cacheWarmingStatus) : "Inactive (cache warming unavailable)"}\n`;
		const decision = cacheWarmingStatus?.decision;
		if (decision?.economicsAvailable) {
			info += `${theme.fg("dim", "Estimated cache miss penalty:")} $${decision.missCost.toFixed(3)}\n`;
			info += `${theme.fg("dim", "Estimated refresh cost:")} $${decision.warmCost.toFixed(3)}\n`;
		}

		if (stats.cost > 0 || cacheWaste.missedTokens > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} $${stats.cost.toFixed(3)}`;
			// A single entry repeats the total, unless it names a model other than the selected one.
			if (usageBreakdown.length > 1 || usageBreakdown[0]?.key !== selectedModelKey) {
				for (const entry of usageBreakdown) {
					info += `\n  ${theme.fg("dim", `${entry.key}:`)} $${entry.cost.toFixed(3)} ${theme.fg("dim", `(${formatTokens(entry.tokens)} tokens)`)}`;
				}
			}
			if (cacheWaste.missedTokens > 0) {
				const missLabel = cacheWaste.missCount === 1 ? "1 miss" : `${cacheWaste.missCount} misses`;
				const detail = `${cacheWaste.missedTokens.toLocaleString()} tokens, ${missLabel}`;
				info +=
					cacheWaste.missedCost >= 0.0001
						? `\n${theme.fg("dim", "Estimated cache re-billing:")} $${cacheWaste.missedCost.toFixed(3)} ${theme.fg("dim", `(${detail})`)}`
						: `\n${theme.fg("dim", "Estimated cache re-billing:")} ${detail}`;
			}
		}
		return info;
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
