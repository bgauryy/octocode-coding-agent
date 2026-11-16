import { type Component, truncateToWidth } from "@octocodeai/octocode-tui";
import { theme } from "../../../../theme/theme.ts";
import { keyHint, keyText, moveHint, renderHintLine } from "../../../../theme/theme-tui-helpers.ts";
import { plainText } from "../styled-line.ts";
import type { NameFilter, SortMode } from "../session-selector-search.ts";
import type { SessionScope } from "./types.ts";

export type { SessionScope };

/** Where the selection stands: its position among the rows shown, how many are shown, how many sessions there are. */
export interface SessionCounts {
	position: number;
	shown: number;
	total: number;
	/** Rows marked for deletion. */
	marked?: number;
}

const sep = () => theme.fg("muted", " · ");

export class SessionSelectorHeader implements Component {
	private scope: SessionScope;
	private sortMode: SortMode;
	private nameFilter: NameFilter;
	private requestRender: () => void;
	private loading = false;
	private loadProgress: { loaded: number; total: number } | null = null;
	private showPath = false;
	private confirmingDeleteCount = 0;
	private statusMessage: { type: "info" | "error"; message: string } | null = null;
	private statusTimeout: ReturnType<typeof setTimeout> | null = null;
	private showRenameHint = false;
	private showActionsHint = false;
	private previewOpen = false;
	private counts: () => SessionCounts = () => ({ position: 0, shown: 0, total: 0 });

	constructor(scope: SessionScope, sortMode: SortMode, nameFilter: NameFilter, requestRender: () => void) {
		this.scope = scope;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.requestRender = requestRender;
	}

	setScope(scope: SessionScope): void {
		this.scope = scope;
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
	}

	setLoading(loading: boolean): void {
		this.loading = loading;
		// Progress is scoped to the current load; clear whenever the loading state is set
		this.loadProgress = null;
	}

	setProgress(loaded: number, total: number): void {
		this.loadProgress = { loaded, total };
	}

	setShowPath(showPath: boolean): void {
		this.showPath = showPath;
	}

	setShowRenameHint(show: boolean): void {
		this.showRenameHint = show;
	}

	setShowActionsHint(show: boolean): void {
		this.showActionsHint = show;
	}

	setPreviewOpen(open: boolean): void {
		this.previewOpen = open;
	}

	/** Where the title gets `(n of N)` from. */
	setCounts(counts: () => SessionCounts): void {
		this.counts = counts;
	}

	/** How many sessions the delete question covers; 0 when none is open. */
	setConfirmingDeleteCount(count: number): void {
		this.confirmingDeleteCount = count;
	}

	private clearStatusTimeout(): void {
		if (!this.statusTimeout) return;
		clearTimeout(this.statusTimeout);
		this.statusTimeout = null;
	}

	setStatusMessage(msg: { type: "info" | "error"; message: string } | null, autoHideMs?: number): void {
		this.clearStatusTimeout();
		this.statusMessage = msg ? { ...msg, message: plainText(msg.message) } : null;
		if (!msg || !autoHideMs) return;

		this.statusTimeout = setTimeout(() => {
			this.statusMessage = null;
			this.statusTimeout = null;
			this.requestRender();
		}, autoHideMs);
	}

	invalidate(): void {}

	/** `Resume session (3 of 97) · ◉ This folder ○ All · Sort: Recent`, one line. */
	render(width: number): string[] {
		const { position, shown, total, marked = 0 } = this.counts();
		const of = shown < total ? `${position} of ${shown} · ${total} total` : `${position} of ${total}`;
		const count = total > 0 ? theme.fg("muted", ` (${of})`) : "";
		const left = theme.bold("Resume session") + count;

		let scopeText: string;
		if (this.loading) {
			const progressText = this.loadProgress ? `${this.loadProgress.loaded}/${this.loadProgress.total}` : "...";
			const loadingScope = this.scope === "all" ? "○ This folder ◉ All" : "◉ This folder ○ All";
			scopeText = `${theme.fg("muted", loadingScope)}${sep()}${theme.fg("accent", `Loading ${progressText}`)}`;
		} else if (this.scope === "current") {
			scopeText = `${theme.fg("accent", "◉ This folder")}${theme.fg("muted", " ○ All")}`;
		} else {
			scopeText = `${theme.fg("muted", "○ This folder ")}${theme.fg("accent", "◉ All")}`;
		}
		const sortLabel = this.sortMode === "threaded" ? "Threaded" : this.sortMode === "recent" ? "Recent" : "Fuzzy";
		const parts = [scopeText];
		if (marked > 0) parts.push(theme.fg("error", `${marked} marked`));
		if (this.nameFilter === "named") parts.push(theme.fg("accent", "Named only"));
		parts.push(theme.fg("muted", "Sort: ") + theme.fg("accent", sortLabel));
		return [truncateToWidth(`${left}${sep()}${parts.join(sep())}`, width, "…")];
	}

	/** One line: the hints that fit, most useful first; a delete confirmation or status message replaces them. */
	renderFooter(width: number): string[] {
		if (this.confirmingDeleteCount > 0) {
			const what = this.confirmingDeleteCount === 1 ? "session" : `${this.confirmingDeleteCount} sessions`;
			const confirmHint = `Delete ${what}? ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`;
			return [theme.fg("error", truncateToWidth(confirmHint, width, "…"))];
		}
		if (this.statusMessage) {
			const color = this.statusMessage.type === "error" ? "error" : "accent";
			return [theme.fg(color, truncateToWidth(this.statusMessage.message, width, "…"))];
		}
		return [
			renderHintLine(
				[
					moveHint(11),
					[keyText("tui.select.confirm"), "resume", 0],
					["space", this.previewOpen ? "close preview" : "preview", 6],
					[keyText("tui.input.tab"), "scope", 3],
					...(this.showRenameHint ? [[keyText("app.session.rename"), "rename", 7] as const] : []),
					[keyText("app.session.mark"), "mark", 5],
					[keyText("app.session.delete"), "delete", 2],
					...(this.showActionsHint ? [[keyText("app.session.actions"), "actions", 4] as const] : []),
					[keyText("app.session.toggleSort"), "sort", 8],
					[keyText("app.session.toggleNamedFilter"), "named", 9],
					[keyText("app.session.togglePath"), `path ${this.showPath ? "(on)" : "(off)"}`, 10],
					[keyText("tui.select.cancel"), "close", 1],
				],
				width,
				0,
			),
		];
	}
}
