import { type Component, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import { theme } from "../../../../theme/theme.ts";
import { keyHint } from "../keybinding-hints.ts";
import type { NameFilter, SortMode } from "../session-selector-search.ts";
import type { SessionScope } from "./types.ts";

export type { SessionScope };

/** Where the selection stands: its position among the rows shown, how many are shown, how many sessions there are. */
export interface SessionCounts {
	position: number;
	shown: number;
	total: number;
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
	private confirmingDeletePath: string | null = null;
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

	setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
	}

	private clearStatusTimeout(): void {
		if (!this.statusTimeout) return;
		clearTimeout(this.statusTimeout);
		this.statusTimeout = null;
	}

	setStatusMessage(msg: { type: "info" | "error"; message: string } | null, autoHideMs?: number): void {
		this.clearStatusTimeout();
		this.statusMessage = msg;
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
		const { position, shown, total } = this.counts();
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
		if (this.nameFilter === "named") parts.push(theme.fg("accent", "Named only"));
		parts.push(theme.fg("muted", "Sort: ") + theme.fg("accent", sortLabel));
		return [truncateToWidth(`${left}${sep()}${parts.join(sep())}`, width, "…")];
	}

	/** One line: the hints that fit, most useful first; a delete confirmation or status message replaces them. */
	renderFooter(width: number): string[] {
		if (this.confirmingDeletePath !== null) {
			const confirmHint = `Delete session? ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`;
			return [theme.fg("error", truncateToWidth(confirmHint, width, "…"))];
		}
		if (this.statusMessage) {
			const color = this.statusMessage.type === "error" ? "error" : "accent";
			return [theme.fg(color, truncateToWidth(this.statusMessage.message, width, "…"))];
		}
		const hints = [
			keyHint("tui.select.confirm", "resume"),
			theme.fg("dim", "space") + theme.fg("muted", this.previewOpen ? " close preview" : " preview"),
			keyHint("tui.input.tab", "scope"),
			...(this.showRenameHint ? [keyHint("app.session.rename", "rename")] : []),
			keyHint("app.session.delete", "delete"),
			...(this.showActionsHint ? [keyHint("app.session.actions", "actions")] : []),
			keyHint("app.session.toggleSort", "sort"),
			keyHint("app.session.toggleNamedFilter", "named"),
			keyHint("app.session.togglePath", `path ${this.showPath ? "(on)" : "(off)"}`),
			keyHint("tui.select.cancel", "close"),
		];
		const shown = [theme.fg("dim", "↑↓") + theme.fg("muted", " move")];
		for (const hint of hints) {
			if (visibleWidth([...shown, hint].join(sep())) > width) break;
			shown.push(hint);
		}
		return [truncateToWidth(shown.join(sep()), width, "…")];
	}
}
