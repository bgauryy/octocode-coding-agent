import type { SessionInfo } from "./session-manager.ts";

export type SessionScope = "current" | "all";

/** What a host knows about a session beyond its transcript: shown on line 2 of its row and in the preview. */
export interface SessionExtras {
	/** Another process (or this one) has the session open now. */
	live?: boolean;
	branch?: string;
	/** `main` or `worktree <name>`. */
	checkout?: string;
	/** Cost as text, e.g. `≈$1.84`. */
	cost?: string;
	files?: number;
	/** Backlog items the session holds, e.g. `B300`. */
	items?: string[];
	agent?: string;
	children?: number;
}

/** A host action listed in the menu behind `app.session.actions`. The picker knows no action by name. */
export interface SessionAction {
	label: string;
	run(session: SessionInfo): void | Promise<void>;
}

/** What a host supplies to the session picker. */
export interface SessionPickerPorts {
	/** A fast first page (a catalog); the full transcript listing replaces it when it arrives. */
	quickList?(scope: SessionScope, signal: AbortSignal): Promise<SessionInfo[]>;
	/** Per-session extras by session id. Synchronous: hosts read a local index. */
	extras?(ids: readonly string[]): ReadonlyMap<string, SessionExtras>;
	/** Host actions behind the one key `app.session.actions`; each runs after the picker has closed. */
	actions?: readonly SessionAction[];
	/** Terminal rows the picker may fill; defaults to the terminal height. */
	viewportRows?(): number;
}

/** Options of `ExtensionUIContext.pickSession`. */
export interface SessionPickerOptions extends SessionPickerPorts {
	/** Scope, query and sort the picker opens with (default: this folder, empty, recent). */
	initialScope?: SessionScope;
	initialQuery?: string;
	/** Lists only the sessions with these ids, whatever the scope or query. */
	onlySessions?: ReadonlySet<string>;
}
