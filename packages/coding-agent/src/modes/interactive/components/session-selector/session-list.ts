import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	matchesKey,
	truncateToWidth,
} from "@octocodeai/octocode-tui";
import type { KeybindingsManager } from "../../../../core/keybindings.ts";
import type { SessionInfo } from "../../../../core/session-manager.ts";
import { sessionTitle } from "../../../../core/session-manager/title.ts";
import { theme } from "../../../../theme/theme.ts";
import {
	filterAndSortSessions,
	hasSessionName,
	isTranscriptOnlyMatch,
	type NameFilter,
	type SortMode,
} from "../session-selector-search.ts";
import { buildSessionTree, type FlatSessionNode, flattenSessionTree } from "./session-tree.ts";
import { canonicalizePath } from "../../../../../../common/src/paths.ts";
import { checkoutLabel } from "../../../../core/worktree-path.ts";
import type { SessionCounts } from "./header.ts";
import { type GroupMode, groupNodes, listItems, scrollTop, visibleItems } from "./groups.ts";
import { emptyMessage, renderGroupLabel, renderSearchBox } from "./list-chrome.ts";
import { DeleteFlow } from "./marks.ts";
import { renderPreview } from "./preview.ts";
import { renderSessionRow } from "./row.ts";
import type { SessionExtras, SessionPickerPorts } from "./types.ts";
import { folderColumn } from "./utils.ts";

/** Lines of the picker that are not list rows: top border, title, search box (3) and footer. */
const CHROME_LINES = 6;
/** The list never gets fewer lines than one row and its group label. */
const MIN_LIST_LINES = 4;

const terminalRows = (): number => Math.max(1, (process.stdout.rows || 24) - 1);

/**
 * Custom session list component: a search box over a window of two-line session rows, grouped by day or folder.
 */
export class SessionList implements Component, Focusable {
	public getSelectedSessionPath(): string | undefined {
		const selected = this.filteredSessions[this.selectedIndex];
		return selected?.session.path;
	}

	public getSelectedSession(): SessionInfo | undefined {
		return this.filteredSessions[this.selectedIndex]?.session;
	}

	/** Where the selection stands, for the title: `(3 of 97)`. */
	public getCounts(): SessionCounts {
		const shown = this.filteredSessions.length;
		return {
			position: shown === 0 ? 0 : this.selectedIndex + 1,
			shown,
			total: this.allSessions.length,
			marked: this.deleteFlow.markedCount,
		};
	}

	public setQuery(query: string): void {
		this.searchInput.setValue(query);
		this.filterSessions(query);
	}

	private allSessions: SessionInfo[] = [];
	private filteredSessions: FlatSessionNode[] = [];
	private groupLabels = new Map<number, string>();
	private groupMode: GroupMode = "none";
	private selectedIndex: number = 0;
	private selectionTouched = false;
	private top = 0;
	private lastListLines = 0;
	private previewOpen = false;
	private searchInput: Input;
	private showCwd = false;
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private keybindings: KeybindingsManager;
	private showPath = false;
	private readonly deleteFlow = new DeleteFlow({
		extras: (session) => this.extras.get(session.id),
		isCurrent: (session) => this.isCurrentSessionPath(session.path),
		selected: () => this.getSelectedSession(),
		moveDown: () => this.move(this.selectedIndex + 1),
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

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
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
		this.searchInput = new Input({
			prompt: "⌕ ",
			placeholder: 're:<regex> · "exact phrase"',
			placeholderStyle: (text) => theme.fg("dim", text),
		});
		this.showCwd = showCwd;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.keybindings = keybindings;
		this.currentSessionCanonicalPath = currentSessionFilePath && canonicalizePath(currentSessionFilePath);
		this.setSessions(sessions, showCwd);

		this.searchInput.onSubmit = () => {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected) this.onSelect?.(selected.session.path);
		};
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
		this.filterSessions(this.searchInput.getValue());
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
		this.filterSessions(this.searchInput.getValue());
	}

	setSessions(sessions: SessionInfo[], showCwd: boolean): void {
		const selectedPath = this.selectionTouched ? this.getSelectedSessionPath() : undefined;
		this.allSessions = sessions;
		this.showCwd = showCwd;
		this.byPath = new Map(sessions.map((session) => [canonicalizePath(session.path), session]));
		this.deleteFlow.keepOnly(new Set(sessions.map((session) => session.path)));
		this.extras = this.ports.extras?.(sessions.map((session) => session.id)) ?? new Map();
		this.filterSessions(this.searchInput.getValue());
		if (!this.selectionTouched) {
			this.selectedIndex = 0;
		} else if (selectedPath) {
			const selectedIndex = this.filteredSessions.findIndex((node) => node.session.path === selectedPath);
			if (selectedIndex >= 0) this.selectedIndex = selectedIndex;
		}
	}

	private filterSessions(query: string): void {
		const trimmed = query.trim();
		const nameFiltered =
			this.nameFilter === "all" ? this.allSessions : this.allSessions.filter((session) => hasSessionName(session));

		let nodes: FlatSessionNode[];
		if (this.sortMode === "threaded" && !trimmed) {
			// Threaded mode without search: show tree structure
			nodes = flattenSessionTree(buildSessionTree(nameFiltered));
		} else {
			// Other modes or with search: flat list
			const filtered = filterAndSortSessions(nameFiltered, query, this.sortMode, "all");
			nodes = filtered.map((session) => ({ session, depth: 0, isLast: true, ancestorContinues: [] }));
		}
		// Only a list in recency order is divided; threads and relevance order are not.
		this.groupMode = this.sortMode !== "recent" ? "none" : this.showCwd ? "folder" : "date";
		const grouped = groupNodes(nodes, this.groupMode);
		this.filteredSessions = grouped.nodes;
		this.groupLabels = grouped.labels;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredSessions.length - 1));
		this.top = 0;
	}

	private checkoutLabel(folder: string): string | undefined {
		if (!this.checkoutLabels.has(folder)) this.checkoutLabels.set(folder, checkoutLabel(folder));
		return this.checkoutLabels.get(folder);
	}

	private isCurrentSessionPath(path: string): boolean {
		if (!this.currentSessionCanonicalPath) return false;
		return canonicalizePath(path) === this.currentSessionCanonicalPath;
	}

	private listLines(): number {
		const rows = this.ports.viewportRows?.() ?? terminalRows();
		return Math.max(MIN_LIST_LINES, rows - CHROME_LINES);
	}

	private parentTitle(session: SessionInfo): string | undefined {
		if (!session.parentSessionPath) return undefined;
		const parent = this.byPath.get(canonicalizePath(session.parentSessionPath));
		return parent ? sessionTitle(parent, 80) || undefined : undefined;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = renderSearchBox(this.searchInput, width);

		if (this.filteredSessions.length === 0) {
			lines.push(
				theme.fg(
					"muted",
					truncateToWidth(emptyMessage(this.nameFilter, this.showCwd, this.searchInput.getValue()), width, "…"),
				),
			);
			return lines;
		}

		const height = this.listLines();
		this.lastListLines = height;

		if (this.previewOpen) {
			const session = this.filteredSessions[this.selectedIndex].session;
			lines.push(...renderPreview(session, this.extras.get(session.id), width).slice(0, height));
			return lines;
		}

		const items = listItems(this.filteredSessions.length, this.groupLabels);
		this.top = scrollTop(items, this.top, this.selectedIndex, height);
		const query = this.searchInput.getValue();
		for (const item of visibleItems(items, this.top, height)) {
			if ("label" in item) {
				lines.push(renderGroupLabel(item.label, this.groupMode, (f) => this.checkoutLabel(f), width));
				continue;
			}
			const node = this.filteredSessions[item.row];
			const session = node.session;
			lines.push(
				...renderSessionRow({
					node,
					width,
					selected: item.row === this.selectedIndex,
					current: this.isCurrentSessionPath(session.path),
					confirmingDelete: this.deleteFlow.isConfirming(session.path),
					marked: this.deleteFlow.isMarked(session.path),
					showPath: this.showPath,
					...(this.showCwd && this.groupMode === "none" && session.cwd
						? { folder: folderColumn(session.cwd, this.checkoutLabel(session.cwd), 40) }
						: {}),
					extras: this.extras.get(session.id),
					transcriptMatch: isTranscriptOnlyMatch(session, query),
					parentTitle: this.parentTitle(session),
				}),
			);
		}
		return lines;
	}

	private setPreviewOpen(open: boolean): void {
		this.previewOpen = open;
		this.onPreviewChange?.(open);
	}

	private move(to: number): void {
		this.selectedIndex = Math.max(0, Math.min(this.filteredSessions.length - 1, to));
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
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected) {
				this.onRenameSession?.(selected.session.path);
			}
			return;
		}

		// Host actions for the selected session
		if (kb.matches(keyData, "app.session.actions")) {
			const selected = this.getSelectedSession();
			if (selected) this.onOpenActions?.(selected);
			return;
		}

		// Ctrl+Backspace: non-invasive convenience alias for delete
		// Only triggers deletion when the query is empty; otherwise it is forwarded to the input
		if (kb.matches(keyData, "app.session.deleteNoninvasive")) {
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.handleInput(keyData);
				this.filterSessions(this.searchInput.getValue());
				return;
			}

			this.deleteFlow.ask();
			return;
		}

		// Space shows the preview; once a query is typed it is part of the query (`"exact phrase"`).
		if (matchesKey(keyData, "space") && this.searchInput.getValue() === "") {
			if (this.filteredSessions.length > 0) this.setPreviewOpen(!this.previewOpen);
			return;
		}
		if (this.previewOpen && kb.matches(keyData, "tui.select.cancel")) {
			this.setPreviewOpen(false);
			return;
		}

		if (this.deleteFlow.markedCount > 0 && kb.matches(keyData, "tui.select.cancel")) {
			this.deleteFlow.clearMarks();
			return;
		}

		this.selectionTouched = true;
		const page = Math.max(1, Math.floor((this.lastListLines || this.listLines()) / 2));
		if (kb.matches(keyData, "tui.select.up")) {
			this.move(this.selectedIndex - 1);
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.move(this.selectedIndex + 1);
		} else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.move(this.selectedIndex - page);
		} else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.move(this.selectedIndex + page);
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.session.path);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
		} else {
			this.searchInput.handleInput(keyData);
			this.filterSessions(this.searchInput.getValue());
		}
	}
}
