import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { SessionInfo, SessionListProgress } from "../../../../core/session-manager.ts";
import type { SessionSelectorHeader } from "./header.ts";
import type { SessionList } from "./session-list.ts";
import type { SessionPickerPorts, SessionScope } from "./types.ts";

export type SessionsLoader = (onProgress?: SessionListProgress, signal?: AbortSignal) => Promise<SessionInfo[]>;

/** What the listings draw into: the picker's header and list, the scope on screen and its render request. */
export interface SessionLoadView {
	readonly header: SessionSelectorHeader;
	readonly list: SessionList;
	scope(): SessionScope;
	requestRender(): void;
}

const SCOPES: readonly SessionScope[] = ["current", "all"];

/**
 * The picker's two listings (this folder, all folders): at most one abortable load per scope, the last result of each,
 * and how the quick first page, progress and failures reach the header and list. A load for a scope that is not on
 * screen keeps its result for when the user switches to it.
 */
export class SessionLoads {
	private readonly sessions: Record<SessionScope, SessionInfo[] | null> = { current: null, all: null };
	private readonly loads: Record<SessionScope, AbortController | null> = { current: null, all: null };

	private readonly view: SessionLoadView;
	private readonly loaders: Record<SessionScope, SessionsLoader>;
	private readonly ports: Pick<SessionPickerPorts, "quickList">;

	constructor(
		view: SessionLoadView,
		loaders: Record<SessionScope, SessionsLoader>,
		ports: Pick<SessionPickerPorts, "quickList"> = {},
	) {
		this.view = view;
		this.loaders = loaders;
		this.ports = ports;
	}

	/** The last complete or partial listing for `scope`, or null when it has none. */
	sessionsFor(scope: SessionScope): SessionInfo[] | null {
		return this.sessions[scope];
	}

	isLoading(scope: SessionScope): boolean {
		return this.loads[scope] !== null;
	}

	/** Drops a deleted session from both listings. */
	remove(sessionPath: string): void {
		for (const scope of SCOPES) {
			this.sessions[scope] = this.sessions[scope]?.filter((s) => s.path !== sessionPath) ?? null;
		}
	}

	/** Aborts every running load and forgets its partial listing. */
	cancel(): void {
		for (const scope of SCOPES) {
			const load = this.loads[scope];
			if (!load) continue;
			load.abort();
			this.loads[scope] = null;
			this.sessions[scope] = null;
		}
	}

	/** Forgets both listings and loads the scope on screen again (after a rename or delete). */
	async refresh(): Promise<void> {
		this.cancel();
		this.sessions.current = null;
		this.sessions.all = null;
		await this.load(this.view.scope());
	}

	async load(scope: SessionScope): Promise<void> {
		if (this.loads[scope]) return;
		const { header, list } = this.view;
		const showCwd = scope === "all";
		const controller = new AbortController();
		this.loads[scope] = controller;
		header.setScope(scope);
		header.setLoading(true);
		this.view.requestRender();

		const isActive = () => this.loads[scope] === controller;
		const onScreen = () => scope === this.view.scope();
		// A quick first page paints at once, unless the full listing got there first.
		let fuller = false;
		void this.ports
			.quickList?.(scope, controller.signal)
			.then((quick) => {
				if (fuller || !isActive() || !onScreen() || quick.length === 0) return;
				list.setSessions(quick, showCwd);
				this.view.requestRender();
			})
			.catch(() => {});
		const onProgress: SessionListProgress = (loaded, total, partialSessions) => {
			if (!isActive()) return;
			if (partialSessions) {
				fuller = true;
				const sessions = [...partialSessions];
				this.sessions[scope] = sessions;
				if (onScreen()) list.setSessions(sessions, showCwd);
			}
			if (!onScreen()) return;
			header.setProgress(loaded, total);
			this.view.requestRender();
		};

		try {
			const sessions = await this.loaders[scope](onProgress, controller.signal);
			fuller = true;
			if (!isActive()) return;
			this.sessions[scope] = sessions;
			this.loads[scope] = null;
			if (!onScreen()) return;
			header.setLoading(false);
			list.setSessions(sessions, showCwd);
			this.view.requestRender();
		} catch (err) {
			if (!isActive()) return;
			this.loads[scope] = null;
			this.sessions[scope] = null;
			if (!onScreen()) return;
			header.setLoading(false);
			header.setStatusMessage({ type: "error", message: `Failed to load sessions: ${errorMessage(err)}` }, 4000);
			list.setSessions([], showCwd);
			this.view.requestRender();
		}
	}
}
