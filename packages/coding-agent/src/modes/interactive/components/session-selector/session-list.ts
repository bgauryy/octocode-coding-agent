import {
	type Component,
	type Focusable,
	getKeybindings,
	ListView,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@octocodeai/octocode-tui";
import type { KeybindingsManager } from "../../../../core/keybindings.ts";
import type { SessionInfo } from "../../../../core/session-manager.ts";
import { sessionTitle } from "../../../../core/session-manager/title.ts";
import {
	filterAndSortSessions,
	hasSessionName,
	isTranscriptOnlyMatch,
	type NameFilter,
	type SortMode,
} from "../session-selector-search.ts";
import { buildSessionTree, type FlatSessionNode, flattenSessionTree } from "./session-tree.ts";
import { canonicalizePath } from "@octocodeai/octocode-common/paths";
import { checkoutLabel, checkoutText } from "../../../../core/worktree-path.ts";
import type { SessionCounts } from "./header.ts";
import { type GroupMode, groupNodes, type SessionRow, sessionRows } from "./groups.ts";
import { emptyFor, renderGroupLabel } from "./list-chrome.ts";
import { DeleteFlow } from "./marks.ts";
import { renderPreview } from "./preview.ts";
import { renderSessionRow } from "./row.ts";
import type { SessionExtras, SessionPickerPorts } from "./types.ts";
import { dropLastWord, folderColumn, terminalRows } from "./utils.ts";
import { listTheme } from "../list-kit.ts";

/** Lines of the picker that are not list rows: top rule, title, search line, hint line and closing rule. */
const CHROME_LINES = 5;
/** The list never gets fewer lines than one row, its group label and the position line. */
const MIN_LIST_LINES = 4;

/**
 * The session list: a `⌕` search line over two-line session rows on `ListView`, grouped by day or folder. The search
 * keeps the session syntax (`re:<regex>`, `"exact phrase"`) and the highlighted session across every change.
 */
export class SessionList implements Component, Focusable {
	public getSelectedSessionPath(): string | undefined {
		return this.getSelectedSession()?.path;
	}

	public getSelectedSession(): SessionInfo | undefined {
		return this.list.getSelectedItem()?.node.session;
	}

	/** Where the selection stands among the rows shown, and how many rows are marked. */
	public getCounts(): SessionCounts {
		const shown = this.list.getItems().length;
		return {
			position: shown === 0 ? 0 : this.list.getSelectedIndex() + 1,
			shown,
			total: this.allSessions.length,
			marked: this.deleteFlow.markedCount,
		};
	}

	public setQuery(query: string): void {
		this.keepingSelection(() => this.list.setQuery(query));
	}

	private allSessions: SessionInfo[] = [];
	private readonly list: ListView<SessionRow>;
	private lastSelectedPath?: string;
	private selectionTouched = false;
	private previewOpen = false;
	private showCwd = false;
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private keybindings: KeybindingsManager;
	private showPath = false;
	private readonly deleteFlow = new DeleteFlow({
		extras: (session) => this.extras.get(session.id),
		isCurrent: (session) => this.isCurrentSessionPath(session.path),
		selected: () => this.getSelectedSession(),
		moveDown: () => this.list.move(1),
		error: (message) => this.onError?.(message),
		confirmationChanged: (paths) => this.onDeleteConfirmationChange?.(paths),
		marksChanged: (count) => this.onMarksChange?.(count),
	});
	private currentSessionCanonicalPath?: string;
	private readonly ports: Pick<SessionPickerPorts, "extras" | "viewportRows">;
	private extras: ReadonlyMap<string, SessionExtras> = new Map();
	private byPath = new Map<string, SessionInfo>();
	/** `main` / `worktree <name>` per folder, read once per picker: a render must not touch the disk for each row. */
	private readonly checkoutLabels = new Map<string, string | undefined>();
	private readonly checkoutTexts = new Map<string, string | undefined>();
	public onSelect?: (sessionPath: string) => void;
	public onCancel?: () => void;
	public onExit: () => void = () => {};
	public onToggleScope?: () => void;
	public onToggleSort?: () => void;
	public onToggleNameFilter?: () => void;
	public onTogglePath?: (showPath: boolean) => void;
	public onPreviewChange?: (open: boolean) => void;
	public onOpenActions?: (session: SessionInfo) => void;
	/** The transcripts the user is asked to confirm deleting (the marked rows, else the selected one), null when not asking. */
	public onDeleteConfirmationChange?: (paths: string[] | null) => void;
	public onDeleteSessions?: (sessionPaths: string[]) => Promise<void>;
	public onRenameSession?: (sessionPath: string) => void;
	public onMarksChange?: (count: number) => void;
	public onError?: (message: string) => void;

	// The search line shows the hardware cursor while the picker has focus.
	get focused(): boolean {
		return this.list.focused;
	}
	set focused(value: boolean) {
		this.list.focused = value;
	}

	constructor(
		sessions: SessionInfo[],
		showCwd: boolean,
		sortMode: SortMode,
		nameFilter: NameFilter,
		keybindings: KeybindingsManager,
		currentSessionFilePath?: string,
		ports: Pick<SessionPickerPorts, "extras" | "viewportRows"> = {},
	) {
		this.ports = ports;
		this.list = new ListView<SessionRow>({
			items: [],
			maxRows: 1,
			theme: listTheme(),
			// Session rows draw their own `›` and fill the width with the selected background.
			mark: false,
			row: (item, state) => this.renderRow(item, state.selected, state.width),
			search: {
				text: (item) => item.node.session.name ?? "",
				// The query has its own syntax, sort and grouping: the rows are rebuilt from every session, not narrowed.
				filter: (_items, query) => this.rowsFor(query),
				placeholder: 're:<regex> · "exact phrase"',
			},
		});
		this.list.onSelect = (item) => this.onSelect?.(item.node.session.path);
		this.list.onCancel = () => this.onCancel?.();
		this.showCwd = showCwd;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.keybindings = keybindings;
		this.currentSessionCanonicalPath = currentSessionFilePath && canonicalizePath(currentSessionFilePath);
		this.setSessions(sessions, showCwd);
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
		this.rebuild();
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
		this.rebuild();
	}

	setSessions(sessions: SessionInfo[], showCwd: boolean): void {
		this.allSessions = sessions;
		this.showCwd = showCwd;
		this.byPath = new Map(sessions.map((session) => [canonicalizePath(session.path), session]));
		this.deleteFlow.keepOnly(new Set(sessions.map((session) => session.path)));
		this.extras = this.ports.extras?.(sessions.map((session) => session.id)) ?? new Map();
		this.rebuild();
		if (!this.selectionTouched) this.list.setSelectedIndex(0);
	}

	/** Only a list in recency order is divided; threads and relevance order are not. */
	private groupMode(): GroupMode {
		return this.sortMode !== "recent" ? "none" : this.showCwd ? "folder" : "date";
	}

	/** The rows for `query`: the fork tree while threaded without a query, else the sorted, searched flat list. */
	private rowsFor(query: string): SessionRow[] {
		const named =
			this.nameFilter === "all" ? this.allSessions : this.allSessions.filter((session) => hasSessionName(session));
		const nodes: FlatSessionNode[] =
			this.sortMode === "threaded" && !query.trim()
				? flattenSessionTree(buildSessionTree(named))
				: filterAndSortSessions(named, query, this.sortMode, "all").map((session) => ({
						session,
						depth: 0,
						isLast: true,
						ancestorContinues: [],
					}));
		return sessionRows(groupNodes(nodes, this.groupMode()));
	}

	private rebuild(): void {
		this.keepingSelection(() => this.list.setItems(this.rowsFor("")));
	}

	/**
	 * Run a change to the rows, then highlight the session that was highlighted before, or the last one that was.
	 * `onQueryChange`: only when the change edited the query (a key may also just move the cursor).
	 */
	private keepingSelection(change: () => void, onQueryChange = false): void {
		const selectedPath = this.getSelectedSessionPath() ?? this.lastSelectedPath;
		this.lastSelectedPath = selectedPath;
		const index = this.list.getSelectedIndex();
		const query = this.list.getQuery();
		change();
		if (onQueryChange && this.list.getQuery() === query) return;
		const rows = this.list.getItems();
		const retained = rows.findIndex((row) => row.node.session.path === selectedPath);
		this.list.setSelectedIndex(retained >= 0 ? retained : Math.min(index, rows.length - 1));
	}

	private checkoutLabel(folder: string): string | undefined {
		if (!this.checkoutLabels.has(folder)) this.checkoutLabels.set(folder, checkoutLabel(folder));
		return this.checkoutLabels.get(folder);
	}

	private checkoutText(folder: string): string | undefined {
		if (!this.checkoutTexts.has(folder)) this.checkoutTexts.set(folder, checkoutText(folder));
		return this.checkoutTexts.get(folder);
	}

	private isCurrentSessionPath(path: string): boolean {
		if (!this.currentSessionCanonicalPath) return false;
		return canonicalizePath(path) === this.currentSessionCanonicalPath;
	}

	/** Lines under the search line: the rows, their group labels and the `a–b/total` line. */
	private listLines(): number {
		const rows = this.ports.viewportRows?.() ?? terminalRows();
		return Math.max(MIN_LIST_LINES, rows - CHROME_LINES);
	}

	private parentTitle(session: SessionInfo): string | undefined {
		if (!session.parentSessionPath) return undefined;
		const parent = this.byPath.get(canonicalizePath(session.parentSessionPath));
		return parent ? sessionTitle(parent, 80) || undefined : undefined;
	}

	private renderRow(item: SessionRow, selected: boolean, width: number): string[] {
		const session = item.node.session;
		const cwd = session.cwd;
		const groupMode = this.groupMode();
		const row = renderSessionRow({
			node: item.node,
			width,
			selected,
			current: this.isCurrentSessionPath(session.path),
			confirmingDelete: this.deleteFlow.isConfirming(session.path),
			marked: this.deleteFlow.isMarked(session.path),
			showPath: this.showPath,
			...(this.showCwd && groupMode === "none" && cwd
				? { folder: folderColumn(cwd, this.checkoutLabel(cwd), 40) }
				: {}),
			extras: this.extras.get(session.id),
			...(cwd && this.checkoutText(cwd) ? { checkout: this.checkoutText(cwd) } : {}),
			transcriptMatch: isTranscriptOnlyMatch(session, this.list.getQuery()),
			parentTitle: this.parentTitle(session),
		});
		if (item.label === undefined) return row;
		return [renderGroupLabel(item.label, groupMode, (folder) => this.checkoutLabel(folder), width), ...row];
	}

	/** As many rows as fit in `lines` with their labels, keeping one line for `a–b/total` when the list scrolls. */
	private fitWindow(lines: number): void {
		const rows = this.list.getItems();
		const scrolls = rows.length * 2 > lines;
		const room = scrolls ? lines - 1 : lines;
		for (let count = Math.max(1, Math.floor(room / 2)); ; count--) {
			this.list.setMaxRows(count);
			if (count === 1) return;
			const { start, end } = this.list.visibleRange();
			let used = 0;
			for (let index = start; index < end; index++) used += rows[index].label === undefined ? 2 : 3;
			if (used <= room) return;
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const empty = emptyFor(this.nameFilter, this.showCwd, this.list.getQuery());
		this.list.setEmpty(empty);
		const height = this.listLines();
		const session = this.getSelectedSession();
		if (this.previewOpen && session) {
			this.list.setMaxRows(1);
			const [search = ""] = this.list.render(width);
			const checkout = session.cwd ? this.checkoutText(session.cwd) : undefined;
			const extras = this.extras.get(session.id);
			const shown = checkout && checkout !== "main" ? { ...extras, checkout } : extras;
			return [search, ...renderPreview(session, shown, width).slice(0, height)];
		}
		this.fitWindow(height);
		return this.list.render(width);
	}

	private setPreviewOpen(open: boolean): void {
		this.previewOpen = open;
		this.onPreviewChange?.(open);
	}

	/**
	 * The list's mouse: the wheel moves one session, a press selects, a click on the selected session resumes it. None
	 * while the preview or a delete question is open: a click never answers a destructive question.
	 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.previewOpen || this.deleteFlow.confirming) return undefined;
		const result = this.list.handleMouse(event);
		if (result) this.selectionTouched = true;
		return result;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		// Handle delete confirmation state first - intercept all keys
		if (this.deleteFlow.confirming) {
			const confirmed = kb.matches(keyData, "tui.select.confirm");
			// Any key but Enter and Esc is ignored while asking.
			if (!confirmed && !kb.matches(keyData, "tui.select.cancel")) return;
			const paths = this.deleteFlow.answer(confirmed);
			if (paths.length > 0) void this.onDeleteSessions?.(paths);
			return;
		}

		if (kb.matches(keyData, "tui.input.tab")) {
			this.onToggleScope?.();
			return;
		}

		if (kb.matches(keyData, "app.session.toggleSort")) {
			this.onToggleSort?.();
			return;
		}

		if (this.keybindings.matches(keyData, "app.session.toggleNamedFilter")) {
			this.onToggleNameFilter?.();
			return;
		}

		if (kb.matches(keyData, "app.session.togglePath")) {
			this.showPath = !this.showPath;
			this.onTogglePath?.(this.showPath);
			return;
		}

		// Ctrl+D: initiate delete confirmation (useful on terminals that don't distinguish Ctrl+Backspace from Backspace)
		if (kb.matches(keyData, "app.session.delete")) {
			this.deleteFlow.ask();
			return;
		}

		// Ctrl+X: mark the selected row for deletion
		if (kb.matches(keyData, "app.session.mark")) {
			this.deleteFlow.toggleMark();
			return;
		}

		if (kb.matches(keyData, "app.session.rename")) {
			const selected = this.getSelectedSessionPath();
			if (selected) this.onRenameSession?.(selected);
			return;
		}

		// Host actions for the selected session
		if (kb.matches(keyData, "app.session.actions")) {
			const selected = this.getSelectedSession();
			if (selected) this.onOpenActions?.(selected);
			return;
		}

		// Ctrl+Backspace deletes only when the query is empty; with a query it erases the last word.
		if (kb.matches(keyData, "app.session.deleteNoninvasive")) {
			const query = this.list.getQuery();
			if (query.length > 0) this.setQuery(dropLastWord(query));
			else this.deleteFlow.ask();
			return;
		}

		// Space shows the preview; once a query is typed it is part of the query (`"exact phrase"`).
		if (matchesKey(keyData, "space") && this.list.getQuery() === "") {
			if (this.list.getItems().length > 0) this.setPreviewOpen(!this.previewOpen);
			return;
		}

		// Esc closes the preview, then drops the marks, then clears the query (the list), then cancels.
		if (this.previewOpen && kb.matches(keyData, "tui.select.cancel")) {
			this.setPreviewOpen(false);
			return;
		}
		if (this.deleteFlow.markedCount > 0 && kb.matches(keyData, "tui.select.cancel")) {
			this.deleteFlow.clearMarks();
			return;
		}

		this.selectionTouched = true;
		this.keepingSelection(() => this.list.handleInput(keyData), true);
	}
}
