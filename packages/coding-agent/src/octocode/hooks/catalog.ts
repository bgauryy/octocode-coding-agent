/**
 * The hook event catalog: the one owner of which events exist, which source profiles accept each, and what a profile's
 * handlers may declare and receive there. Parsing, payload projection, `/hooks`, the generated hook-event reference
 * and the conformance tests read it; the dispatchers in `register/` implement each event at runtime.
 */

/** Source dialects remain distinct even when their handlers use identical command text. */
export type HookProtocol = "octocode" | "claude" | "codex";
export type HookHandlerType = "command" | "http" | "prompt" | "mcp_tool";
/** Host metadata a profile adds to the event input when it is available. */
type HookInputField = "model" | "permission_mode" | "turn_id" | "agent";

/** What one profile accepts for one event. */
export interface ProfileEventSupport {
	/** Handler types besides `command`. */
	handlers: readonly Exclude<HookHandlerType, "command">[];
	/** Host metadata added to this event's input. */
	input: readonly HookInputField[];
	/** Default timeout in seconds; the profile default when absent. */
	timeout?: number;
	/** Largest accepted timeout in seconds; `HOOK_MAX_TIMEOUT_S` when absent. */
	maxTimeout?: number;
	/** The upstream host ignores matchers on this event, so every group matches. */
	ignoresMatcher?: true;
	/** Codex `additionalContextLimit` applies: the event can emit additional context. */
	contextLimit?: true;
	/** Asynchronous command handlers are rejected. */
	synchronous?: true;
}

export interface HookEventSpec {
	/** What the event does in Octocode, shown in the generated reference. */
	behavior: string;
	/** A required hook (`failClosed`, Claude `onFailure: "block"`) with invalid configuration still denies matching calls. */
	gate?: true;
	profiles: Partial<Record<HookProtocol, ProfileEventSupport>>;
}

/** Default command timeout per profile, in seconds. */
export const PROFILE_TIMEOUT_S: Record<HookProtocol, number> = { octocode: 60, claude: 600, codex: 600 };

/** Command-handler fields each profile accepts. */
export const PROFILE_COMMAND_FIELDS: Record<HookProtocol, readonly string[]> = {
	octocode: ["type", "command", "timeout", "failClosed", "statusMessage"],
	claude: [
		"type",
		"command",
		"timeout",
		"failClosed",
		"statusMessage",
		"args",
		"shell",
		"onFailure",
		"async",
		"asyncRewake",
	],
	codex: [
		"type",
		"command",
		"timeout",
		"failClosed",
		"statusMessage",
		"commandWindows",
		"async",
		"additionalContextLimit",
	],
};

const native: ProfileEventSupport = { handlers: [], input: [] };
const CLAUDE_INPUT = ["permission_mode", "agent"] as const;
const claude = (
	handlers: ProfileEventSupport["handlers"],
	{ input = [], ...extra }: Partial<ProfileEventSupport> = {},
): ProfileEventSupport => ({ handlers: [...handlers, "mcp_tool"], input: [...CLAUDE_INPUT, ...input], ...extra });
const codex = (input: readonly HookInputField[], extra: Partial<ProfileEventSupport> = {}): ProfileEventSupport => ({
	handlers: ["mcp_tool"],
	input,
	...extra,
});
const GATE = ["http", "prompt"] as const;
const OBSERVER = ["http"] as const;
const CODEX_TOOL = ["model", "permission_mode", "turn_id", "agent"] as const;

/** Every event Octocode implements, in dispatch-report order. */
export const HOOK_CATALOG = {
	PreToolUse: {
		behavior:
			"Denies calls, supplies context and applies supported source-profile rewrites before normal permission checks.",
		gate: true,
		profiles: { octocode: native, claude: claude(GATE), codex: codex(CODEX_TOOL, { contextLimit: true }) },
	},
	PermissionRequest: {
		behavior: "Allows or denies an approval that would otherwise be asked; an allow lasts for that request.",
		gate: true,
		profiles: { claude: claude(GATE), codex: codex(CODEX_TOOL) },
	},
	PostToolUse: {
		behavior:
			"Native/Claude append feedback; Codex can replace results. Successful file queries are handled individually.",
		profiles: { octocode: native, claude: claude(GATE), codex: codex(CODEX_TOOL, { contextLimit: true }) },
	},
	PostToolUseFailure: {
		behavior: "Observes failures and can add context.",
		profiles: { claude: claude(GATE) },
	},
	PostToolBatch: {
		behavior: "Observes the completed batch once; blocking prevents the next model request.",
		profiles: { claude: claude(GATE, { ignoresMatcher: true }) },
	},
	SessionStart: {
		behavior: "Supplies context for the next prompt, including after compaction.",
		profiles: {
			octocode: native,
			claude: claude([], { input: ["model"] }),
			codex: codex(["model", "permission_mode"], { contextLimit: true }),
		},
	},
	SubagentStart: {
		behavior: "Supplies child context when child hooks are enabled.",
		profiles: {
			claude: claude(OBSERVER),
			codex: codex(["model", "permission_mode", "turn_id"], { contextLimit: true }),
		},
	},
	SubagentStop: {
		behavior: "Gates child completion when child hooks are enabled.",
		profiles: { claude: claude(GATE), codex: codex(["model", "permission_mode", "turn_id"]) },
	},
	Interrupt: {
		behavior: "Observes an explicitly interrupted main turn after cancellation; cannot continue it.",
		profiles: {
			codex: codex(["model", "permission_mode", "turn_id"], { timeout: 1, maxTimeout: 3, ignoresMatcher: true }),
		},
	},
	SessionEnd: {
		behavior: "Observes supported termination reasons within a separate cleanup deadline.",
		profiles: {
			octocode: { handlers: [], input: [], timeout: 1.5, maxTimeout: 60 },
			claude: claude(OBSERVER, { timeout: 1.5, synchronous: true }),
			codex: { handlers: [], input: [], timeout: 1, maxTimeout: 3 },
		},
	},
	AgentOn: {
		behavior:
			"Octocode only: observes an agent of this process joining the team (main session or child); the matcher is its role. Cannot block or add context.",
		profiles: { octocode: { handlers: [], input: [], timeout: 1.5, maxTimeout: 60 } },
	},
	AgentQueued: {
		behavior:
			"Octocode only: observes a background child this process queued behind prerequisites (`after`, or the open `dependsOn` of its item); the matcher is its role. It starts on its own when they end well (AgentOn then adds `started_after`). Cannot block or add context.",
		profiles: { octocode: { handlers: [], input: [], timeout: 1.5, maxTimeout: 60 } },
	},
	AgentOff: {
		behavior:
			"Octocode only: observes an agent this process retired from the team, within a separate 1.5 s deadline; the matcher is the end reason (completed, failed, stopped-user, stopped-parent, parent-gone, crashed, left). Cannot block or delay the exit.",
		profiles: { octocode: { handlers: [], input: [], timeout: 1.5, maxTimeout: 60 } },
	},
	TaskCreated: {
		behavior: "Octocode only: observes a backlog item this process added. Cannot block or add context.",
		profiles: { octocode: { handlers: [], input: [], timeout: 1.5, maxTimeout: 60 } },
	},
	TaskCompleted: {
		behavior:
			"Octocode only: gates the `backlog` tool's `done` and `close` of an item in this process, before it is written; exit 2 (or `decision: \"block\"`) refuses it with the reason. A hook that fails or times out lets the write go ahead. Writes from the web board, `/backlog` or another process are not gated. The matcher is `done` or `closed`. Before any hook runs, Octocode's own check refuses `done` while this session still runs children, bash jobs or timers for the item (or for items derived from it), reserves its paths or keeps worktrees made for it, and names what to release; `close` as obsolete, duplicate or wont_do is never blocked. That check is not a hook and cannot be turned off.",
		gate: true,
		profiles: { octocode: native },
	},
	BacklogChange: {
		behavior:
			"Octocode only: observes every audited change to a backlog item, whichever process or surface wrote it, once per session that follows the backlog; the matcher is the change kind. Cannot block or add context.",
		profiles: { octocode: { handlers: [], input: [], timeout: 1.5, maxTimeout: 60 } },
	},
	MonitorAlert: {
		behavior:
			"Octocode only: observes each alert the monitor raised, once per alert; the matcher is the monitor rule id. A machine rule runs the hook in the one process holding the sampler lease; the other rules run it in the session they belong to. Cannot block or add context.",
		profiles: { octocode: { handlers: [], input: [], timeout: 1.5, maxTimeout: 60 } },
	},
	UserPromptSubmit: {
		behavior: "Gates normal prompts, steering and follow-ups; Claude runs at admission, Codex when input is consumed.",
		gate: true,
		profiles: {
			claude: claude(GATE, { timeout: 30, ignoresMatcher: true }),
			codex: codex(CODEX_TOOL, { contextLimit: true, ignoresMatcher: true }),
		},
	},
	PreCompact: {
		behavior: "Native is observational; supported source-profile vetoes reach the compaction owner.",
		profiles: { octocode: native, claude: claude(OBSERVER), codex: codex(["model", "turn_id", "agent"]) },
	},
	PostCompact: {
		behavior: "Claude observes; Codex can stop continuation after compaction.",
		profiles: { claude: claude(OBSERVER), codex: codex(["model", "turn_id", "agent"]) },
	},
	Stop: {
		behavior: "Can request continuation; explicit source-profile termination takes precedence.",
		profiles: {
			octocode: native,
			claude: claude(GATE, { ignoresMatcher: true }),
			codex: codex(["model", "permission_mode", "turn_id"], { ignoresMatcher: true }),
		},
	},
	StopFailure: {
		behavior: "Observes final error settlement; output cannot control the run.",
		profiles: { claude: claude(OBSERVER) },
	},
	Notification: {
		behavior: "Background observer; cannot block. Explicit Claude `async: true` can defer context.",
		profiles: { octocode: native, claude: claude(OBSERVER) },
	},
	PreMessageSend: {
		behavior: "Octocode message gate; can deny or ask before sending.",
		gate: true,
		profiles: { octocode: native },
	},
	PostMessageReceive: {
		behavior: "Observes delivery; cannot rewrite messages or request a reply.",
		profiles: { octocode: native },
	},
} as const satisfies Record<string, HookEventSpec>;

export type HookEvent = keyof typeof HOOK_CATALOG;
export const HOOK_EVENTS = Object.keys(HOOK_CATALOG) as HookEvent[];

/**
 * Events the upstream hosts document that Octocode does not implement yet, checked 2026-11-10 against the Claude Code
 * hooks reference (changelog 2.1.312) and Codex `main` 3535c22b. They are reported as not implemented rather than unknown.
 */
export const UPSTREAM_ONLY_EVENTS: Record<Exclude<HookProtocol, "octocode">, readonly string[]> = {
	claude: [
		"Setup",
		"UserPromptExpansion",
		"PermissionDenied",
		"MessageDisplay",
		"TeammateIdle",
		"InstructionsLoaded",
		"ConfigChange",
		"CwdChanged",
		"DirectoryAdded",
		"FileChanged",
		"WorktreeCreate",
		"WorktreeRemove",
		"PreModelSwitch",
		"PostModelSwitch",
		"Elicitation",
		"ElicitationResult",
	],
	codex: ["PreModelRequest", "PostModelRequest"],
};

const isHookEvent = (event: string): event is HookEvent => Object.hasOwn(HOOK_CATALOG, event);

/** What `protocol` accepts for `event`, or undefined when that profile rejects it. */
export function profileSupport(protocol: HookProtocol, event: string): ProfileEventSupport | undefined {
	if (!isHookEvent(event)) return undefined;
	const profiles: HookEventSpec["profiles"] = HOOK_CATALOG[event].profiles;
	return profiles[protocol];
}

/** The events a profile accepts, in catalog order. */
export const profileEvents = (protocol: HookProtocol): HookEvent[] =>
	HOOK_EVENTS.filter((event) => profileSupport(protocol, event));
