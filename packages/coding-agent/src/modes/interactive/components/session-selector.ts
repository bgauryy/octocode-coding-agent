import { type Component, Container, type Focusable, getKeybindings, Input, Spacer } from "@octocodeai/octocode-tui";
import { KeybindingsManager } from "../../../core/keybindings.ts";
import type { SessionInfo } from "../../../core/session-manager.ts";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { SessionSelectorHeader } from "./session-selector/header.ts";
import { SessionLoads, type SessionsLoader } from "./session-selector/loads.ts";
import { type ActionsMenu, actionsMenuFor, renamePanel } from "./session-selector/panels.ts";
import { SessionList } from "./session-selector/session-list.ts";
import type { SessionPickerPorts, SessionRemoval, SessionScope } from "./session-selector/types.ts";
import { deleteSessionFile } from "./session-selector/utils.ts";
import type { NameFilter, SortMode } from "./session-selector-search.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

interface SessionSelectorOptions extends SessionPickerPorts {
	renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
	showRenameHint?: boolean;
	keybindings?: KeybindingsManager;
	/** Scope, query and sort the picker opens with (default: this folder, empty, threaded). */
	initialScope?: SessionScope;
	initialQuery?: string;
	initialSort?: SortMode;
}

/**
 * Component that renders a session selector
 */
export class SessionSelectorComponent extends Container implements Focusable {
	handleInput(data: string): void {
		if (this.mode === "rename") {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.cancel")) {
				this.exitRenameMode();
				return;
			}
			this.renameInput.handleInput(data);
			return;
		}
		if (this.mode === "actions") {
			this.actionsMenu?.handleInput(data);
			return;
		}

		this.sessionList.handleInput(data);
	}

	private sessionList: SessionList;
	private header: SessionSelectorHeader;
	private keybindings: KeybindingsManager;
	private scope: SessionScope = "current";
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private readonly loads: SessionLoads;
	private requestRender: () => void;
	private renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;

	private mode: "list" | "rename" | "actions" = "list";
	private renameInput = new Input();
	private renameTargetPath: string | null = null;
	private actionsMenu: ActionsMenu | null = null;
	private readonly ports: SessionPickerPorts;

	// Focusable implementation - propagate to sessionList for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.sessionList.focused = value;
		this.renameInput.focused = value;
		if (value && this.mode === "rename") {
			this.renameInput.focused = true;
		}
	}

	/** Border, title, content, hints: the list is the only content that fills the terminal. */
	private buildBaseLayout(content: Component, options?: { showHeader?: boolean }): void {
		this.clear();
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		if (options?.showHeader ?? true) {
			this.addChild(this.header);
			this.addChild(content);
			this.addChild({ render: (width) => this.header.renderFooter(width), invalidate: () => {} });
		} else {
			this.addChild(new Spacer(1));
			this.addChild(content);
			this.addChild(new Spacer(1));
			this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		}
	}

	constructor(
		currentSessionsLoader: SessionsLoader,
		allSessionsLoader: SessionsLoader,
		onSelect: (sessionPath: string) => void,
		onCancel: () => void,
		onExit: () => void,
		requestRender: () => void,
		options?: SessionSelectorOptions,
		currentSessionFilePath?: string,
	) {
		super();
		this.ports = options ?? {};
		this.scope = options?.initialScope ?? "current";
		this.sortMode = options?.initialSort ?? "threaded";
		this.keybindings = options?.keybindings ?? KeybindingsManager.create();
		this.requestRender = requestRender;
		this.header = new SessionSelectorHeader(this.scope, this.sortMode, this.nameFilter, this.requestRender);
		const renameSession = options?.renameSession;
		this.renameSession = renameSession;
		this.header.setShowRenameHint(options?.showRenameHint ?? !!renameSession);
		this.header.setShowActionsHint(!!options?.actions?.length);

		// Create session list (starts empty, will be populated after load)
		this.sessionList = new SessionList(
			[],
			this.scope === "all",
			this.sortMode,
			this.nameFilter,
			this.keybindings,
			currentSessionFilePath,
			{ extras: options?.extras, viewportRows: options?.viewportRows },
		);
		if (options?.initialQuery) this.sessionList.setQuery(options.initialQuery);
		this.loads = new SessionLoads(
			{
				header: this.header,
				list: this.sessionList,
				scope: () => this.scope,
				requestRender: () => this.requestRender(),
			},
			{ current: currentSessionsLoader, all: allSessionsLoader },
			this.ports,
		);
		this.header.setCounts(() => this.sessionList.getCounts());
		this.header.setSortMode(this.sortMode);
		this.sessionList.onPreviewChange = (open) => {
			this.header.setPreviewOpen(open);
			this.requestRender();
		};
		this.sessionList.onOpenActions = (session) => this.enterActionsMode(session);

		this.buildBaseLayout(this.sessionList);

		this.renameInput.onSubmit = (value) => {
			void this.confirmRename(value);
		};

		// Leaving the selector stops its loads and header status timer
		const leaving =
			<A extends unknown[]>(next: (...args: A) => void) =>
			(...args: A) => {
				this.dispose();
				next(...args);
			};
		this.sessionList.onSelect = leaving(onSelect);
		this.sessionList.onCancel = leaving(onCancel);
		this.sessionList.onExit = leaving(onExit);
		this.sessionList.onToggleScope = () => this.toggleScope();
		this.sessionList.onToggleSort = () => this.toggleSortMode();
		this.sessionList.onToggleNameFilter = () => this.toggleNameFilter();
		this.sessionList.onRenameSession = (sessionPath) => {
			if (!renameSession) return;
			if (this.loads.isLoading(this.scope)) return;

			const sessions = this.loads.sessionsFor(this.scope) ?? [];
			const session = sessions.find((s) => s.path === sessionPath);
			this.enterRenameMode(sessionPath, session?.name);
		};

		// Sync list events to header
		this.sessionList.onTogglePath = (showPath) => {
			this.header.setShowPath(showPath);
			this.requestRender();
		};
		this.sessionList.onDeleteConfirmationChange = (paths) => {
			this.header.setConfirmingDeleteCount(paths?.length ?? 0);
			this.requestRender();
		};
		this.sessionList.onMarksChange = () => this.requestRender();
		this.sessionList.onError = (msg) => {
			this.header.setStatusMessage({ type: "error", message: msg }, 3000);
			this.requestRender();
		};

		this.sessionList.onDeleteSessions = (sessionPaths) => this.deleteSessions(sessionPaths);

		// Start loading immediately
		void this.loads.load(this.scope);
	}

	/** Stops session listing and the header's status timer; the host calls it when another view replaces the picker. */
	dispose(): void {
		this.header.setStatusMessage(null);
		this.loads.cancel();
	}

	/** Deletes the confirmed sessions through the host's removal when it has one, else file by file, and reports the outcome. */
	private async deleteSessions(paths: string[]): Promise<void> {
		const known = new Map(
			(this.loads.sessionsFor(this.scope) ?? []).map((session) => [session.path, session] as const),
		);
		const sessions = paths.flatMap((file) => known.get(file) ?? []);
		let outcome: SessionRemoval;
		try {
			outcome = await (this.ports.removeSessions ? this.ports.removeSessions(sessions) : this.removeFiles(sessions));
		} catch (err) {
			this.header.setStatusMessage({ type: "error", message: `Failed to delete: ${errorMessage(err)}` }, 5000);
			this.requestRender();
			return;
		}
		for (const file of outcome.removed) this.loads.remove(file);
		this.sessionList.setSessions(this.loads.sessionsFor(this.scope) ?? [], this.scope === "all");
		const { removed, problems } = outcome;
		const done =
			removed.length === 0
				? ""
				: removed.length === 1
					? outcome.method === "trash"
						? "Session moved to trash"
						: "Session deleted"
					: `${removed.length} sessions ${outcome.method === "trash" ? "moved to trash" : "deleted"}`;
		const kept = problems.length === 0 ? "" : `${problems.length} not deleted: ${problems.join("; ")}`;
		this.header.setStatusMessage(
			{ type: problems.length > 0 ? "error" : "info", message: [done, kept].filter(Boolean).join(" · ") },
			problems.length > 0 ? 8000 : 2000,
		);
		this.requestRender();
		await this.loads.refresh();
		this.requestRender();
	}

	/** Without a host removal: each transcript to the trash, else unlinked. */
	private async removeFiles(sessions: readonly SessionInfo[]): Promise<SessionRemoval> {
		const outcome: SessionRemoval = { removed: [], problems: [] };
		for (const session of sessions) {
			const result = await deleteSessionFile(session.path);
			if (result.ok) {
				outcome.removed.push(session.path);
				outcome.method = result.method;
			} else outcome.problems.push(`${session.name ?? session.id}: ${result.error ?? "unknown error"}`);
		}
		return outcome;
	}

	private enterRenameMode(sessionPath: string, currentName: string | undefined): void {
		this.mode = "rename";
		this.renameTargetPath = sessionPath;
		this.renameInput.setValue(currentName ?? "");
		this.renameInput.focused = true;

		this.buildBaseLayout(renamePanel(this.renameInput), { showHeader: false });
		this.requestRender();
	}

	private exitRenameMode(): void {
		this.mode = "list";
		this.renameTargetPath = null;

		this.buildBaseLayout(this.sessionList);

		this.requestRender();
	}

	private enterActionsMode(session: SessionInfo): void {
		const actions = this.ports.actions;
		if (!actions?.length || this.mode !== "list") return;
		this.mode = "actions";
		this.actionsMenu = actionsMenuFor(
			session,
			actions,
			() => this.exitActionsMode(),
			(label, err) => {
				this.header.setStatusMessage({ type: "error", message: `${label}: ${errorMessage(err)}` }, 3000);
				this.requestRender();
			},
		);
		this.buildBaseLayout(this.actionsMenu, { showHeader: false });
		this.requestRender();
	}

	private exitActionsMode(): void {
		this.mode = "list";
		this.actionsMenu = null;
		this.buildBaseLayout(this.sessionList);
		this.requestRender();
	}

	private async confirmRename(value: string): Promise<void> {
		const next = value.trim();
		if (!next) return;
		const target = this.renameTargetPath;
		const renameSession = this.renameSession;
		if (!target || !renameSession) return this.exitRenameMode();

		try {
			await renameSession(target, next);
		} catch (err) {
			// The submit handler does not await this; a rejection would end the process as an uncaught crash.
			this.header.setStatusMessage({ type: "error", message: `Failed to rename: ${errorMessage(err)}` }, 4000);
			return this.exitRenameMode();
		}
		this.exitRenameMode();
		await this.loads.refresh();
	}

	private toggleSortMode(): void {
		// Cycle: threaded -> recent -> relevance -> threaded
		this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "relevance" : "threaded";
		this.header.setSortMode(this.sortMode);
		this.sessionList.setSortMode(this.sortMode);
		this.requestRender();
	}

	private toggleNameFilter(): void {
		this.nameFilter = this.nameFilter === "all" ? "named" : "all";
		this.header.setNameFilter(this.nameFilter);
		this.sessionList.setNameFilter(this.nameFilter);
		this.requestRender();
	}

	private toggleScope(): void {
		this.scope = this.scope === "current" ? "all" : "current";
		const sessions = this.loads.sessionsFor(this.scope);
		const loading = this.loads.isLoading(this.scope);
		this.header.setScope(this.scope);
		this.header.setLoading(loading);
		this.sessionList.setSessions(sessions ?? [], this.scope === "all");
		this.requestRender();
		if (sessions === null && !loading) void this.loads.load(this.scope);
	}

	getSessionList(): SessionList {
		return this.sessionList;
	}
}
