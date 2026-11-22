/**
 * Who an event or message came from, and how far to trust it. A leaf: plain serializable types and one pure function,
 * no imports, so every layer (db, wake, team, permission) can depend on it without a cycle.
 */

export type SourceKind =
	| "terminal"
	| "web"
	| "acp"
	| "child"
	| "peer"
	| "external"
	| "hook"
	| "timer"
	| "job"
	| "system"
	| "mcp"
	| "webcontent"
	| "unknown";

export type SourceChannel = "terminal" | "web" | "acp" | "socket" | "db" | "in-process" | "tool-result";

/** `proven`: checked by code we own; `self-reported`: the sender's own claim; `none`: nothing known. */
export type SourceVerified = "proven" | "self-reported" | "none";

/** 4 authority (terminal), 3 delegated (acp, web), 2 fact, 1 request, 0 data. */
export type Trust = 4 | 3 | 2 | 1 | 0;

export interface Source {
	kind: SourceKind;
	/** Agent name, hook id, job id, client name or host. */
	id: string;
	channel: SourceChannel;
	identity?: { pid?: number; instance?: string; process?: string; client?: string; via?: string };
	verified: SourceVerified;
	/** Derived by `trustOf` from kind, channel and verified, never from message text. */
	trust: Trust;
}

/** The channel each interface kind must arrive on to count as itself. */
const OWN_CHANNEL: Partial<Record<SourceKind, SourceChannel>> = { terminal: "terminal", web: "web", acp: "acp" };

const BASE_TRUST: Record<SourceKind, Trust> = {
	terminal: 4,
	acp: 3,
	web: 3,
	timer: 2,
	job: 2,
	system: 2,
	child: 1,
	peer: 1,
	external: 1,
	hook: 1,
	mcp: 0,
	webcontent: 0,
	unknown: 0,
};

/**
 * The trust of a source. Anything not proven is data (0), and a user interface counts only on its own channel, so a
 * peer cannot pass as the terminal by naming it.
 */
export function trustOf(kind: SourceKind, channel: SourceChannel, verified: SourceVerified): Trust {
	if (verified !== "proven") return 0;
	const own = OWN_CHANNEL[kind];
	if (own !== undefined && own !== channel) return 0;
	return BASE_TRUST[kind];
}

/** Where the full object behind an event lives. */
export interface Handle {
	kind: "result" | "file" | "report" | "log" | "archive" | "memory" | "item";
	/** A content hash for result and file, the id for the rest. */
	id: string;
	path: string;
	digest: string;
	/** File: the content hash; a changed file is a new handle. */
	version?: string;
}
