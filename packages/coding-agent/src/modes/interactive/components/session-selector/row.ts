import { GLYPH, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { SessionInfo } from "../../../../core/session-manager.ts";
import { sessionTitle } from "../../../../core/session-manager/title.ts";
import { theme } from "../../../../theme/theme.ts";
import { plainText } from "../styled-line.ts";
import { hasSessionName } from "../session-selector-search.ts";
import type { FlatSessionNode } from "./session-tree.ts";
import type { SessionExtras } from "./types.ts";
import { formatAge, formatSessionTime, shortenPath } from "./utils.ts";
import { cursorMark } from "../../../../theme/theme-tui-helpers.ts";

/** At this width or less, line 2 leaves out the changed-file count. */
const NARROW_WIDTH = 80;

/** Longest title a row asks `sessionTitle` for; the row cuts it to fit. */
const TITLE_CAP = 400;

export interface RowView {
	node: FlatSessionNode;
	width: number;
	selected: boolean;
	current: boolean;
	confirmingDelete: boolean;
	/** Marked for deletion (Ctrl+X). */
	marked?: boolean;
	showPath: boolean;
	/** The session's folder as text, when the list is not grouped by folder. */
	folder?: string;
	extras?: SessionExtras;
	/** Where the folder sits (`worktree x`, `worktree x (gone)`); read from disk by the list, which caches it. */
	checkout?: string;
	/** The query matched the transcript but not the title. */
	transcriptMatch: boolean;
	/** Title of the session this one was forked from; shown while the fork has no prompt of its own. */
	parentTitle?: string;
}

/** What a session is called in a list: its title, else what it was forked from, else a placeholder. */
export function rowTitle(session: SessionInfo, parentTitle?: string, max = TITLE_CAP): string {
	return sessionTitle(session, max) || (parentTitle ? `${GLYPH.reason} ${parentTitle}` : "(no prompt yet)");
}

function treePrefix(node: FlatSessionNode, width: number): string {
	if (node.depth === 0) return "";
	// Keep room for the title and status even after repeated forks.
	const maxLevels = Math.max(0, Math.floor((width - 24) / 3));
	const ancestors = maxLevels === 0 ? [] : node.ancestorContinues.slice(-maxLevels);
	const hidden = node.ancestorContinues.length > ancestors.length;
	const parts = ancestors.map((continues) => (continues ? "│  " : "   "));
	return (hidden ? "… " : "") + parts.join("") + (node.isLast ? "└─ " : "├─ ");
}

interface Part {
	text: string;
	/** Higher goes first when the line is too wide; undefined stays. */
	drop?: number;
}

function detailParts(view: RowView): Part[] {
	const { node, extras, width } = view;
	const session = node.session;
	const narrow = width <= NARROW_WIDTH;
	const parts: Part[] = [{ text: formatAge(session.modified) }];
	const time = formatSessionTime(session.created, session.modified);
	// Kept longer than anything else that may drop: the start time tells sessions of one day apart.
	if (time) parts.push({ text: time, drop: 0 });
	if (view.transcriptMatch) parts.push({ text: "matched in transcript" });
	if (view.folder) parts.push({ text: view.folder, drop: 5 });
	if (view.showPath) parts.push({ text: shortenPath(session.path), drop: 4 });
	if (extras?.branch) parts.push({ text: extras.branch, drop: 7 });
	const checkout = view.checkout ?? extras?.checkout;
	if (checkout && checkout !== "main") parts.push({ text: checkout, drop: 6 });
	// Cost and the agent count outlast branch and checkout: they say what the session did, not where it ran.
	if (extras?.cost) parts.push({ text: extras.cost, drop: 2 });
	if (extras?.children) parts.push({ text: `${extras.children} agent${extras.children === 1 ? "" : "s"}`, drop: 3 });
	if (extras?.files && !narrow) parts.push({ text: `${extras.files} file${extras.files === 1 ? "" : "s"}`, drop: 9 });
	if (extras?.items?.length) parts.push({ text: extras.items.join(" ") });
	if (extras?.agent) parts.push({ text: extras.agent, drop: 8 });
	parts.push({ text: `${session.messageCount} msgs`, drop: 1 });
	return parts;
}

/**
 * Line 2 of a row: age, extras and message count, with the least useful parts dropped until it fits. The session path
 * and a host's extras are untrusted text, so every part is drawn as plain text.
 */
function detailLine(view: RowView, room: number): string {
	const parts = detailParts(view).map((part) => ({ ...part, text: plainText(part.text) }));
	const join = () => parts.map((part) => part.text).join(" · ");
	while (visibleWidth(join()) > room) {
		let worst = -1;
		parts.forEach((part, i) => {
			if (part.drop !== undefined && (worst < 0 || part.drop > (parts[worst]?.drop ?? 0))) worst = i;
		});
		if (worst < 0) break;
		parts.splice(worst, 1);
	}
	return truncateToWidth(join(), Math.max(1, room), "…");
}

function fill(line: string, width: number, selected: boolean): string {
	const cut = truncateToWidth(line, width, "…");
	const padded = cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
	return selected ? theme.bg("selectedBg", padded) : padded;
}

/** The two lines of a session row; neither is wider than `view.width`. */
export function renderSessionRow(view: RowView): string[] {
	const { node, width, selected, current, confirmingDelete } = view;
	const session = node.session;
	const prefix = treePrefix(node, width);
	const cursor = cursorMark(selected);
	const mark = view.marked
		? theme.fg("error", GLYPH.failed)
		: current
			? theme.fg("accent", "◆")
			: view.extras?.live
				? theme.fg("success", GLYPH.live)
				: " ";
	const indent = 2 + visibleWidth(prefix) + 2;

	const title = truncateToWidth(rowTitle(session, view.parentTitle), Math.max(1, width - indent), "…");
	const color = confirmingDelete ? "error" : current ? "accent" : undefined;
	let styled = color ? theme.fg(color, title) : title;
	if (selected || hasSessionName(session)) styled = theme.bold(styled);

	const line1 = `${cursor}${theme.fg("dim", prefix)}${mark} ${styled}`;
	const line2 = `${" ".repeat(indent)}${theme.fg(confirmingDelete ? "error" : "dim", detailLine(view, width - indent))}`;
	return [fill(line1, width, selected), fill(line2, width, selected)];
}
