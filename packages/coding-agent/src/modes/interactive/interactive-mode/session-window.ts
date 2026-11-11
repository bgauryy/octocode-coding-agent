/**
 * Windowed transcript rebuild: resume, `/tree` and `/fork` render only the last entries of the context and leave a
 * "load earlier" row above them. The key (`app.session.loadEarlier`) prepends the previous window below that row.
 */

import type { Component, Container } from "@octocodeai/octocode-tui";
import type { SessionEntry } from "../../../core/session-manager.ts";
import { theme } from "../../../theme/theme.ts";
import { keyHint } from "../components/keybinding-hints.ts";
import { ThemedText } from "../components/themed-text.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Entries rendered by a rebuild, and added by each "load earlier". */
export const RESUME_WINDOW_ENTRIES = 200;

type SessionWindowHost = Pick<InteractiveModeHost, "chatContainer" | "renderSessionEntries">;

/** Loading earlier history also keeps the reader's place in the fullscreen transcript. */
type LoadEarlierHost = SessionWindowHost &
	Pick<InteractiveModeHost, "pendingTools" | "showStatus" | "transcriptScrollView" | "ui">;

interface WindowState {
	/** Entries not rendered yet, oldest first. */
	hidden: SessionEntry[];
	row: Component;
}

const windows = new WeakMap<Container, WindowState>();

const isToolResult = (entry: SessionEntry | undefined): boolean =>
	entry?.type === "message" && entry.message.role === "toolResult";

/**
 * Where the window ending before `end` starts: `limit` entries back, moved earlier past tool results so a tool call is
 * never separated from its results. `floor` keeps a leading compaction summary out of the hidden part.
 */
function windowStart(entries: readonly SessionEntry[], end: number, limit: number, floor: number): number {
	let start = Math.max(floor, end - limit);
	while (start > floor && isToolResult(entries[start])) start--;
	return start;
}

/** Renders `entries` into the chat, the last `limit` of them; the rest wait behind a "load earlier" row. */
export function renderWindowedEntries(
	host: SessionWindowHost,
	entries: SessionEntry[],
	options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	limit = RESUME_WINDOW_ENTRIES,
): void {
	const floor = entries[0]?.type === "compaction" ? 1 : 0;
	const start = windowStart(entries, entries.length, limit, floor);
	if (start <= floor) {
		windows.delete(host.chatContainer);
		host.renderSessionEntries(entries, options);
		return;
	}
	const state: WindowState = {
		hidden: entries.slice(floor, start),
		row: new ThemedText(
			() =>
				theme.fg("dim", `↑ ${state.hidden.length} earlier entries not shown `) +
				keyHint("app.session.loadEarlier", "to load earlier"),
			1,
			0,
		),
	};
	// The compaction summary stays on top; the row sits between it and the window.
	if (floor > 0) host.renderSessionEntries(entries.slice(0, floor), options);
	host.chatContainer.addChild(state.row);
	windows.set(host.chatContainer, state);
	host.renderSessionEntries(entries.slice(start), options);
}

/** Prepends the previous window below the "load earlier" row. Returns false when nothing is hidden. */
export function loadEarlierMessages(host: LoadEarlierHost): boolean {
	const state = windows.get(host.chatContainer);
	const rowIndex = state ? host.chatContainer.children.indexOf(state.row) : -1;
	if (!state || rowIndex < 0) return false;
	const start = windowStart(state.hidden, state.hidden.length, RESUME_WINDOW_ENTRIES, 0);
	const chunk = state.hidden.slice(start);
	state.hidden = state.hidden.slice(0, start);

	const live = new Map(host.pendingTools);
	const before = host.chatContainer.children.length;
	host.renderSessionEntries(chunk);
	// A render resets the pending tools; the chunk is complete history, so only the live ones stay pending.
	host.pendingTools.clear();
	for (const [id, component] of live) host.pendingTools.set(id, component);

	const added = host.chatContainer.children.splice(before);
	host.chatContainer.children.splice(rowIndex + 1, 0, ...added);
	if (state.hidden.length === 0) {
		host.chatContainer.removeChild(state.row);
		windows.delete(host.chatContainer);
	} else state.row.invalidate?.();
	// The rows land above the reader's position: keep what they were reading in view instead of the absolute offset.
	host.transcriptScrollView?.keepRowsInView();
	host.ui.requestRender();
	return true;
}

/** Key handler: loads the previous window, or says there is nothing earlier. */
export function loadEarlierFromKey(host: LoadEarlierHost): void {
	if (!loadEarlierMessages(host)) host.showStatus("No earlier messages to load");
}
