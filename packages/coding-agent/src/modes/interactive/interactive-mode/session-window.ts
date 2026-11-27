import { ThemedText } from "@octocodeai/octocode-tui";
/**
 * Windowed transcript rebuild: resume, `/tree` and `/fork` render only the last entries of the context and leave a
 * "load earlier" row above them. The key (`app.session.loadEarlier`) prepends the previous window below that row.
 */

import type { Component, Container } from "@octocodeai/octocode-tui";
import type { SessionEntry } from "../../../core/session-manager.ts";
import { theme } from "../../../theme/theme.ts";
import { keyHint } from "../../../theme/theme-tui-helpers.ts";
import { SessionWindowIndex } from "./session-window-index.ts";
import type { SessionRenderOptions } from "./session-render-options.ts";
import type { InteractiveModeHost } from "./host.ts";
import { hasLiveFold } from "./live-window.ts";
import { retriedAttemptIds } from "./retried-attempts.ts";

/** Entries rendered by a rebuild, and added by each "load earlier". */
export const RESUME_WINDOW_ENTRIES = 200;

type SessionWindowHost = Pick<InteractiveModeHost, "chatContainer" | "renderSessionEntries" | "pendingTools">;

/** Loading earlier history also keeps the reader's place in the fullscreen transcript. */
type LoadEarlierHost = SessionWindowHost &
	Pick<InteractiveModeHost, "pendingTools" | "showStatus" | "transcriptScrollView" | "ui">;

interface Gap {
	start: number;
	end: number;
	row: Component;
}
interface WindowState {
	entries: SessionEntry[];
	index: SessionWindowIndex;
	gaps: Gap[];
	/** The retried attempts of all entries: an attempt and the edit that set it aside may fall in different ranges. */
	retriedIds: ReadonlySet<string>;
}
const windows = new WeakMap<Container, WindowState>();

function gap(start: number, end: number): Gap {
	return {
		start,
		end,
		row: new ThemedText(
			() =>
				theme.fg("dim", `↑ ${end - start} earlier entries not shown `) +
				keyHint("app.session.loadEarlier", "to load earlier"),
			1,
			0,
		),
	};
}

function* range(start: number, end: number): Generator<number> {
	for (let index = start; index < end; index++) yield index;
}

/** Render one previously hidden interval, leaving a row for each still-hidden portion. */
function renderInterval(
	host: SessionWindowHost,
	state: WindowState,
	start: number,
	end: number,
	selected: readonly number[],
	options: SessionRenderOptions,
): Gap[] {
	const gaps: Gap[] = [];
	let cursor = start;
	let offset = 0;
	while (offset < selected.length) {
		const first = selected[offset];
		if (cursor < first) {
			const hidden = gap(cursor, first);
			gaps.push(hidden);
			host.chatContainer.addChild(hidden.row);
		}
		let after = first + 1;
		while (++offset < selected.length && selected[offset] === after) after++;
		// A reused tool ID must not attach today's live component to an earlier call.
		const liveTools: InteractiveModeHost["pendingTools"] = new Map();
		for (let index = first; options.liveTools?.size && index < after; index++) {
			const entry = state.entries[index];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content ?? []) {
				if (block.type !== "toolCall" || state.index.liveOwners.get(block.id) !== index) continue;
				const live = options.liveTools?.get(block.id);
				if (live) liveTools.set(block.id, live);
			}
		}
		host.renderSessionEntries(state.entries.slice(first, after), { ...options, liveTools });
		cursor = after;
	}
	if (cursor < end) {
		const hidden = gap(cursor, end);
		gaps.push(hidden);
		host.chatContainer.addChild(hidden.row);
	}
	return gaps;
}

/** Keep the tail and its tool dependencies, with unrelated history behind gap rows. */
export function renderWindowedEntries(
	host: SessionWindowHost,
	entries: SessionEntry[],
	options: SessionRenderOptions & { liveToolIds?: ReadonlySet<string> } = {},
	limit = RESUME_WINDOW_ENTRIES,
): void {
	windows.delete(host.chatContainer);
	if (entries.length === 0) {
		host.renderSessionEntries(entries, options);
		return;
	}
	const floor = entries[0]?.type === "compaction" ? 1 : 0;
	const index = new SessionWindowIndex(
		entries,
		floor,
		options.liveToolIds ?? (options.liveTools && new Set(options.liveTools.keys())),
	);
	const retriedIds = options.retriedIds ?? retriedAttemptIds(entries);
	const state: WindowState = { entries, index, gaps: [], retriedIds };
	const seeds = [...range(Math.max(floor, entries.length - limit), entries.length), ...index.liveOwners.values()];
	if (floor) seeds.push(0);
	const selected = index.select(seeds);
	state.gaps = renderInterval(host, state, 0, entries.length, selected, {
		...options,
		toolState: new Map(),
		retriedIds,
	});
	if (state.gaps.length) windows.set(host.chatContainer, state);
}

/** Find an unseen entry's gap without rescanning the saved history on every page. */
function findGap(gaps: readonly Gap[], index: number): Gap {
	let low = 0;
	let high = gaps.length - 1;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (gaps[middle].end <= index) low = middle + 1;
		else high = middle;
	}
	return gaps[low];
}

/** Load the newest gap and any dependencies in older gaps, without replaying mounted rows. */
export function loadEarlierMessages(host: LoadEarlierHost): boolean {
	const state = windows.get(host.chatContainer);
	const newest = state?.gaps.at(-1);
	if (!state || !newest || !host.chatContainer.children.includes(newest.row)) return false;
	const seeds: number[] = [];
	for (let index = state.gaps.length - 1; index >= 0 && seeds.length < RESUME_WINDOW_ENTRIES; index--) {
		const hidden = state.gaps[index];
		seeds.push(...range(Math.max(hidden.start, hidden.end - RESUME_WINDOW_ENTRIES + seeds.length), hidden.end));
	}
	const selected = state.index.select(seeds);
	const byGap = new Map<Gap, number[]>();
	for (const index of selected) {
		const owner = findGap(state.gaps, index);
		const indices = byGap.get(owner) ?? [];
		indices.push(index);
		byGap.set(owner, indices);
	}
	const live = new Map(host.pendingTools);
	const toolState: InteractiveModeHost["pendingTools"] = new Map();
	const replacements = new Map<Gap, Gap[]>();
	// Rebuild the child array once, not once per gap: a page can fill hundreds of
	// small gaps between already-mounted tool rows. The components themselves stay mounted.
	const byRow = new Map([...byGap].map(([hidden, indices]) => [hidden.row, { hidden, indices }]));
	const mounted = host.chatContainer.children.splice(0);
	let consumed = 0;
	try {
		while (consumed < mounted.length) {
			const child = mounted[consumed++];
			const selectedGap = byRow.get(child);
			if (!selectedGap) host.chatContainer.children.push(child);
			else {
				const { hidden, indices } = selectedGap;
				replacements.set(
					hidden,
					renderInterval(host, state, hidden.start, hidden.end, indices, { toolState, retriedIds: state.retriedIds }),
				);
			}
		}
		state.gaps = state.gaps.flatMap((hidden) => replacements.get(hidden) ?? [hidden]);
		if (!state.gaps.length) windows.delete(host.chatContainer);
	} finally {
		while (consumed < mounted.length) host.chatContainer.children.push(mounted[consumed++]);
		host.pendingTools.clear();
		for (const [id, component] of live) host.pendingTools.set(id, component);
	}
	host.transcriptScrollView?.keepRowsInView();
	host.ui.requestRender();
	return true;
}

/** Loads the previous window; a live transcript that folded rows into scrollback is rebuilt as a resume draws it. */
export function loadEarlierFromKey(host: LoadEarlierHost & Pick<InteractiveModeHost, "rebuildChatFromMessages">): void {
	if (loadEarlierMessages(host)) return;
	if (hasLiveFold(host.chatContainer)) {
		host.rebuildChatFromMessages();
		host.ui.requestRender();
		return;
	}
	host.showStatus("No earlier messages to load");
}

/** Only unresolved calls still present in this branch may survive a same-session rebuild. */
export function retainLiveTools(
	entries: readonly SessionEntry[],
	tools: InteractiveModeHost["pendingTools"],
): InteractiveModeHost["pendingTools"] {
	const retained: InteractiveModeHost["pendingTools"] = new Map();
	if (tools.size === 0) return retained;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "toolResult") retained.delete(entry.message.toolCallId);
		else if (entry.message.role === "assistant") {
			for (const block of entry.message.content ?? []) {
				if (block.type !== "toolCall") continue;
				const component = tools.get(block.id);
				if (component && entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted")
					retained.set(block.id, component);
			}
		}
	}
	return retained;
}
