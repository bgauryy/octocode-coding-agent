export interface Reply {
	id?: number;
	result?: unknown;
	error?: { message: string };
	method?: string;
	params?: Record<string, unknown>;
	sessionId?: string;
}

export interface Pending {
	/** The session the command was sent on (none: the browser itself). Only a reply carrying the same one settles it. */
	sessionId: string | undefined;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export type CdpListener = (method: string, params: Record<string, unknown>) => void;

/** What the browser says about a target it attached the session to. */
export interface TargetInfo {
	targetId: string;
	/** `page`, `iframe`, `worker`, `service_worker`, `shared_worker`, `other`, … */
	type: string;
	url?: string;
	/** The page that opened this one (`window.open`, a link to a new window). */
	openerId?: string;
}

export interface PageTarget {
	id: string;
	webSocketDebuggerUrl: string;
	title?: string;
	url?: string;
}
