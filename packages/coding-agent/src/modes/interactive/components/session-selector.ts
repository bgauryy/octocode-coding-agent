import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
} from "@octocodeai/octocode-tui";
import { KeybindingsManager } from "../../../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../../../core/session-manager.ts";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyText } from "./keybinding-hints.ts";
import { type SessionScope, SessionSelectorHeader } from "./session-selector/header.ts";
import { SessionList } from "./session-selector/session-list.ts";
import { deleteSessionFile } from "./session-selector/utils.ts";
import type { NameFilter, SortMode } from "./session-selector-search.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

type SessionsLoader = (onProgress?: SessionListProgress, signal?: AbortSignal) => Promise<SessionInfo[]>;

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

		this.sessionList.handleInput(data);
	}

	private canRename = true;
	private sessionList: SessionList;
	private header: SessionSelectorHeader;
	private keybindings: KeybindingsManager;
	private scope: SessionScope = "current";
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private currentSessions: SessionInfo[] | null = null;
	private allSessions: SessionInfo[] | null = null;
	private currentSessionsLoader: SessionsLoader;
	private allSessionsLoader: SessionsLoader;
	private requestRender: () => void;
	private renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
	private currentLoad: AbortController | null = null;
	private allLoad: AbortController | null = null;

	private mode: "list" | "rename" = "list";
	private renameInput = new Input();
	private renameTargetPath: string | null = null;

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

	private buildBaseLayout(content: Component, options?: { showHeader?: boolean }): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));
		if (options?.showHeader ?? true) {
			this.addChild(this.header);
			this.addChild(new Spacer(1));
		}
		this.addChild(content);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	constructor(
		currentSessionsLoader: SessionsLoader,
		allSessionsLoader: SessionsLoader,
		onSelect: (sessionPath: string) => void,
		onCancel: () => void,
		onExit: () => void,
		requestRender: () => void,
		options?: {
			renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
			showRenameHint?: boolean;
			keybindings?: KeybindingsManager;
		},
		currentSessionFilePath?: string,
	) {
		super();
		this.keybindings = options?.keybindings ?? KeybindingsManager.create();
		this.currentSessionsLoader = currentSessionsLoader;
		this.allSessionsLoader = allSessionsLoader;
		this.requestRender = requestRender;
		this.header = new SessionSelectorHeader(this.scope, this.sortMode, this.nameFilter, this.requestRender);
		const renameSession = options?.renameSession;
		this.renameSession = renameSession;
		this.canRename = !!renameSession;
		this.header.setShowRenameHint(options?.showRenameHint ?? this.canRename);

		// Create session list (starts empty, will be populated after load)
		this.sessionList = new SessionList(
			[],
			false,
			this.sortMode,
			this.nameFilter,
			this.keybindings,
			currentSessionFilePath,
		);

		this.buildBaseLayout(this.sessionList);

		this.renameInput.onSubmit = (value) => {
			void this.confirmRename(value);
		};

		// Ensure header status timeouts are cleared when leaving the selector
		const clearStatusMessage = () => this.header.setStatusMessage(null);
		this.sessionList.onSelect = (sessionPath) => {
			clearStatusMessage();
			this.cancelLoads();
			onSelect(sessionPath);
		};
		this.sessionList.onCancel = () => {
			clearStatusMessage();
			this.cancelLoads();
			onCancel();
		};
		this.sessionList.onExit = () => {
			clearStatusMessage();
			this.cancelLoads();
			onExit();
		};
		this.sessionList.onToggleScope = () => this.toggleScope();
		this.sessionList.onToggleSort = () => this.toggleSortMode();
		this.sessionList.onToggleNameFilter = () => this.toggleNameFilter();
		this.sessionList.onRenameSession = (sessionPath) => {
			if (!renameSession) return;
			if (this.scope === "current" ? this.currentLoad : this.allLoad) return;

			const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
			const session = sessions.find((s) => s.path === sessionPath);
			this.enterRenameMode(sessionPath, session?.name);
		};

		// Sync list events to header
		this.sessionList.onTogglePath = (showPath) => {
			this.header.setShowPath(showPath);
			this.requestRender();
		};
		this.sessionList.onDeleteConfirmationChange = (path) => {
			this.header.setConfirmingDeletePath(path);
			this.requestRender();
		};
		this.sessionList.onError = (msg) => {
			this.header.setStatusMessage({ type: "error", message: msg }, 3000);
			this.requestRender();
		};

		// Handle session deletion
		this.sessionList.onDeleteSession = async (sessionPath: string) => {
			const result = await deleteSessionFile(sessionPath);

			if (result.ok) {
				if (this.currentSessions) {
					this.currentSessions = this.currentSessions.filter((s) => s.path !== sessionPath);
				}
				if (this.allSessions) {
					this.allSessions = this.allSessions.filter((s) => s.path !== sessionPath);
				}

				const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
				const showCwd = this.scope === "all";
				this.sessionList.setSessions(sessions, showCwd);

				const msg = result.method === "trash" ? "Session moved to trash" : "Session deleted";
				this.header.setStatusMessage({ type: "info", message: msg }, 2000);
				await this.refreshSessionsAfterMutation();
			} else {
				const errorMessage = result.error ?? "Unknown error";
				this.header.setStatusMessage({ type: "error", message: `Failed to delete: ${errorMessage}` }, 3000);
			}

			this.requestRender();
		};

		// Start loading current sessions immediately
		void this.loadScope("current");
	}

	private cancelLoads(): void {
		if (this.currentLoad) {
			this.currentLoad.abort();
			this.currentLoad = null;
			this.currentSessions = null;
		}
		if (this.allLoad) {
			this.allLoad.abort();
			this.allLoad = null;
			this.allSessions = null;
		}
	}

	private enterRenameMode(sessionPath: string, currentName: string | undefined): void {
		this.mode = "rename";
		this.renameTargetPath = sessionPath;
		this.renameInput.setValue(currentName ?? "");
		this.renameInput.focused = true;

		const panel = new Container();
		panel.addChild(new Text(theme.bold("Rename Session"), 1, 0));
		panel.addChild(new Spacer(1));
		panel.addChild(this.renameInput);
		panel.addChild(new Spacer(1));
		panel.addChild(
			new Text(
				theme.fg("muted", `${keyText("tui.select.confirm")} to save · ${keyText("tui.select.cancel")} to cancel`),
				1,
				0,
			),
		);

		this.buildBaseLayout(panel, { showHeader: false });
		this.requestRender();
	}

	private exitRenameMode(): void {
		this.mode = "list";
		this.renameTargetPath = null;

		this.buildBaseLayout(this.sessionList);

		this.requestRender();
	}

	private async confirmRename(value: string): Promise<void> {
		const next = value.trim();
		if (!next) return;
		const target = this.renameTargetPath;
		if (!target) {
			this.exitRenameMode();
			return;
		}

		// Find current name for callback
		const renameSession = this.renameSession;
		if (!renameSession) {
			this.exitRenameMode();
			return;
		}

		try {
			await renameSession(target, next);
			await this.refreshSessionsAfterMutation();
		} finally {
			this.exitRenameMode();
		}
	}

	private async loadScope(scope: SessionScope): Promise<void> {
		if (scope === "current" ? this.currentLoad : this.allLoad) return;

		const showCwd = scope === "all";
		const controller = new AbortController();
		if (scope === "current") {
			this.currentLoad = controller;
		} else {
			this.allLoad = controller;
		}
		this.header.setScope(scope);
		this.header.setLoading(true);
		this.requestRender();

		const isActive = () => (scope === "current" ? this.currentLoad : this.allLoad) === controller;
		const onProgress: SessionListProgress = (loaded, total, partialSessions) => {
			if (!isActive()) return;
			if (partialSessions) {
				const sessions = [...partialSessions];
				if (scope === "current") {
					this.currentSessions = sessions;
				} else {
					this.allSessions = sessions;
				}
				if (scope === this.scope) this.sessionList.setSessions(sessions, showCwd);
			}
			if (scope !== this.scope) return;
			this.header.setProgress(loaded, total);
			this.requestRender();
		};

		try {
			const sessions = await (scope === "current"
				? this.currentSessionsLoader(onProgress, controller.signal)
				: this.allSessionsLoader(onProgress, controller.signal));
			if (!isActive()) return;

			if (scope === "current") {
				this.currentSessions = sessions;
				this.currentLoad = null;
			} else {
				this.allSessions = sessions;
				this.allLoad = null;
			}

			if (scope !== this.scope) return;
			this.header.setLoading(false);
			this.sessionList.setSessions(sessions, showCwd);
			this.requestRender();
		} catch (err) {
			if (!isActive()) return;
			if (scope === "current") {
				this.currentLoad = null;
				this.currentSessions = null;
			} else {
				this.allLoad = null;
				this.allSessions = null;
			}
			if (scope !== this.scope) return;

			const message = errorMessage(err);
			this.header.setLoading(false);
			this.header.setStatusMessage({ type: "error", message: `Failed to load sessions: ${message}` }, 4000);
			this.sessionList.setSessions([], showCwd);
			this.requestRender();
		}
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

	private async refreshSessionsAfterMutation(): Promise<void> {
		this.cancelLoads();
		this.currentSessions = null;
		this.allSessions = null;
		await this.loadScope(this.scope);
	}

	private toggleScope(): void {
		this.scope = this.scope === "current" ? "all" : "current";
		const sessions = this.scope === "current" ? this.currentSessions : this.allSessions;
		const loading = (this.scope === "current" ? this.currentLoad : this.allLoad) !== null;
		this.header.setScope(this.scope);
		this.header.setLoading(loading);
		this.sessionList.setSessions(sessions ?? [], this.scope === "all");
		this.requestRender();
		if (sessions === null && !loading) void this.loadScope(this.scope);
	}

	getSessionList(): SessionList {
		return this.sessionList;
	}
}
