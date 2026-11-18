import { envChoice, PERMISSION_ENV, PERMISSION_GRANTS_ENV } from "@octocodeai/octocode-common/env";
import { shortcutText } from "../shared/keys.ts";
import { plural } from "../shared/text.ts";
import { ACTION_CLASSES, type ActionClass, MATRIX, type Rule } from "./action-classes.ts";

export { ACTION_CLASSES, type ActionClass } from "./action-classes.ts";

/**
 * Permission modes: which agent actions run, which ask the user first. One table decides every class in every mode;
 * the invariants (reservations, the Octocode home, redirects to private addresses, an
 * untrusted project's shared memory, hook denies) run before it and no mode skips them. `full` allows every class
 * and records each call. `bypass` (`--dangerously-skip-permissions`) also allows what `full` still asks about (the
 * always-ask classes and reasons) and no session-API turn ceiling holds it; only a start chooses it. Modes are not a
 * sandbox: they decide what Octocode asks about, while the OS user's rights stay what they are.
 */

/** From the strictest to the widest: an index comparison says which of two modes asks about more. */
export const PERMISSION_MODES = ["manual", "workspace", "full", "bypass"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** The modes `/permissions`, the editor shortcut and `--permission-mode` choose; `bypass` has its own start flag. */
export const CHOOSABLE_MODES = ["manual", "workspace", "full"] as const satisfies readonly PermissionMode[];

/** Whether `mode` runs every routine action unasked (`full` and `bypass`): the counter, the warning colour and the run summary follow it. */
export const runsUnasked = (mode: PermissionMode): boolean => mode === "full" || mode === "bypass";

/** Why `action` asks, as the prompt's reason line says it. */
export const actionWhy = (action: ActionClass): string => MATRIX[action].why;

/**
 * Reasons tighten a call. They are not action classes and never a session grant. A provenance hit, a hook ask and a
 * profile that declares permissions ask in manual and workspace; full runs them and records the reason; so does a read of Octocode's credential store (`credential.read`). A source policy's
 * ask, an agent's save of a global or pinned memory, and a read of another tool's credential store (`credential.vendor`,
 * which comes with `credential.read`) ask in every mode: the one exception to "full asks nothing" among reads, since
 * those tokens are another program's sign-in. A reason forces
 * one ask on the call's effect. It does not replace that effect, and a session grant of the effect does not answer it.
 */
export const ASK_REASONS = [
	"hook.ask",
	"provenance",
	"profile.permissions",
	"source.ask",
	"shell.target",
	"memory.wide",
	"credential.read",
	"credential.vendor",
] as const;
export type AskReason = (typeof ASK_REASONS)[number];

const REASON_RULES: Record<AskReason, [Rule, Rule, Rule]> = {
	"shell.target": ["ask", "ask", "allow"],
	"source.ask": ["ask", "ask", "ask"],
	"memory.wide": ["ask", "ask", "ask"],
	"credential.read": ["ask", "ask", "allow"],
	"credential.vendor": ["ask", "ask", "ask"],
	"hook.ask": ["ask", "ask", "allow"],
	provenance: ["ask", "ask", "allow"],
	"profile.permissions": ["ask", "ask", "allow"],
};

/** Whether `reason` forces an ask in `mode`. */
export function reasonAsks(mode: PermissionMode, reason: AskReason): boolean {
	return mode !== "bypass" && REASON_RULES[reason][PERMISSION_MODES.indexOf(mode)] === "ask";
}

/** The least permissive mode in which none of `reasons` ask: full. */
export function modeAllowingReasons(reasons: readonly AskReason[]): PermissionMode | undefined {
	return PERMISSION_MODES.find((mode) => reasons.every((reason) => !reasonAsks(mode, reason)));
}

/** The kind a session-wide grant of `action` covers ("shell commands"); undefined for the per-call tripwires. */
export const kindOf = (action: ActionClass): string | undefined => MATRIX[action].all;

export function decide(mode: PermissionMode, action: ActionClass): Rule {
	return mode === "bypass" ? "allow" : MATRIX[action].rules[PERMISSION_MODES.indexOf(mode)];
}

/** How `action` reads in a message ("the shell command"). */
export const actionNoun = (action: ActionClass): string => MATRIX[action].noun;

/** The least permissive mode that runs `action` without asking. */
export const modeAllowing = (action: ActionClass): PermissionMode | undefined =>
	PERMISSION_MODES.find((mode) => decide(mode, action) === "allow");

/** Asks that a session grant may never answer: their content differs every time, or the hint says it destroys data. */
export const UNGRANTABLE: ReadonlySet<ActionClass> = new Set(
	ACTION_CLASSES.filter((action) => kindOf(action) === undefined && !MATRIX[action].keyed),
);

/** Classes a profile's `permissions:` front matter may declare: what its child needs and the mode would otherwise ask about. */
export const PROFILE_DECLARABLE: readonly ActionClass[] = ["browser.control", "net.private", "upload.outside"];

/**
 * Classes a parent may hand a subagent, which cannot ask anyone: every class with a session kind (what the user allowed
 * for the session), plus the profile-declarable ones. Destructive shell and MCP never pass down, and neither do the
 * classes only a top-level session can meet (a child has no API to receive on and no merge to land) or browser cookie
 * access, which a child asks for through its parent each time (docs/permissions.md).
 */
const NEVER_HANDED_DOWN: ReadonlySet<ActionClass> = new Set(["message.external", "worktree.merge", "browser.cookies"]);
export const SPAWN_GRANTABLE: ReadonlySet<ActionClass> = new Set([
	...ACTION_CLASSES.filter((action) => kindOf(action) !== undefined && !NEVER_HANDED_DOWN.has(action)),
	...PROFILE_DECLARABLE,
]);

/** What a profile's `permissions:` front matter declares: the allowlisted classes, and the names left out (not declarable, or not a name at all). */
export function declaredPermissions(value: unknown): { declared: ActionClass[]; ignored: string[] } {
	const names = (
		Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : value === undefined ? [] : [value]
	)
		.map((name) => (typeof name === "string" ? name.trim() : String(name)))
		.filter(Boolean);
	const declared = new Set<ActionClass>();
	const ignored: string[] = [];
	for (const name of names) {
		if (PROFILE_DECLARABLE.includes(name as ActionClass)) declared.add(name as ActionClass);
		else ignored.push(name);
	}
	return { declared: [...declared], ignored };
}

/** One line per mode for `/permissions`: what it asks about. */
export function asksIn(mode: PermissionMode): ActionClass[] {
	return ACTION_CLASSES.filter((action) => decide(mode, action) === "ask");
}

/**
 * The mode a session starts in: `full` (no routine asks), unless the user exported `OCTOCODE_PERMISSION` (what
 * `--permission-mode` and `--dangerously-skip-permissions` set). An invalid value starts in `manual` with a warning
 * (stricter, never looser).
 */
export function startMode(env: NodeJS.ProcessEnv): { mode: PermissionMode; warning?: string } {
	const chosen = envChoice(env, PERMISSION_ENV, PERMISSION_MODES);
	if (!chosen) return { mode: "full" };
	if ("invalid" in chosen)
		return {
			mode: "manual",
			warning: `${PERMISSION_ENV}=${chosen.invalid} is not manual, workspace, full or bypass; starting in manual.`,
		};
	return { mode: chosen.value };
}

/**
 * The mode the session running in a process left it in, by that process's environment object. `/new`, `/resume`, `/fork`
 * and `/reload` build a new runtime and so a new `Permission`, so a choice the user made has to outlive the instance
 * that holds it.
 */
const carriedModes = new WeakMap<NodeJS.ProcessEnv, PermissionMode>();
export const carryMode = (env: NodeJS.ProcessEnv, mode: PermissionMode): void => void carriedModes.set(env, mode);

/**
 * The mode a session starts in. The first start in a process takes the start mode. A later one, on the instance that
 * holds `current` or on one a `/new`, `/resume`, `/fork` or `/reload` builds (`reason`), takes the stricter of the mode the
 * session was in and the start mode: with nothing exported a chosen mode stays, and an exported one bounds a wider
 * choice, returned as `reverted` for a notice.
 */
export function sessionStartMode(
	env: NodeJS.ProcessEnv,
	current: PermissionMode | undefined,
	reason: "startup" | "reload" | "new" | "resume" | "fork" | undefined,
): { mode: PermissionMode; reverted?: PermissionMode; warning?: string } {
	const { mode: starting, warning } = startMode(env);
	const warned = warning === undefined ? {} : { warning };
	const previous = current ?? (reason !== undefined && reason !== "startup" ? carriedModes.get(env) : undefined);
	if (previous === undefined) return { mode: starting, ...warned };
	const mode = PERMISSION_MODES[Math.min(PERMISSION_MODES.indexOf(previous), PERMISSION_MODES.indexOf(starting))];
	return { mode, ...(mode === previous ? {} : { reverted: previous }), ...warned };
}

/**
 * The classes a parent handed this subagent: its spawn grant (workspace classes its profile reaches and the classes its
 * profile declared) and every kind the user allowed for the parent's session. A name outside `SPAWN_GRANTABLE` (an ask
 * reason, destructive shell, an unknown name) is dropped, whatever the variable says.
 */
export function parseGrants(env: NodeJS.ProcessEnv): Set<ActionClass> {
	const names = (env[PERMISSION_GRANTS_ENV] ?? "").split(",").map((name) => name.trim());
	return new Set(names.filter((name): name is ActionClass => SPAWN_GRANTABLE.has(name as ActionClass)));
}

/** The footer chip's status key (`ui/footer` places it first after the model), the audit entries' type and the mode notes' message type. */
export const PERMISSION_ID = "octocode-permission";

/** The order the editor shortcut cycles modes in, from the default (no routine asks) to the strictest; from `bypass` it goes to the first. */
export const PERMISSION_CYCLE: readonly PermissionMode[] = ["full", "workspace", "manual"];

/** The chip per mode: its text, its short form for a narrow footer, and its theme colour: manual is quiet, workspace is the identity colour, full is a risky mode (warning, never error: it is a choice, not a failure). */
export const CHIPS: Record<PermissionMode, { text: string; short: string; color: "accent" | "muted" | "warning" }> = {
	manual: {
		get text() {
			return `⏸ permission: manual · ${shortcutText("app.permission.cycle")}`;
		},
		short: "⏸ manual",
		color: "muted",
	},
	workspace: {
		get text() {
			return `permission: workspace · ${shortcutText("app.permission.cycle")}`;
		},
		short: "workspace",
		color: "accent",
	},
	full: {
		get text() {
			return `⏵⏵ permission: full · ${shortcutText("app.permission.cycle")}`;
		},
		short: "⏵⏵ full",
		color: "warning",
	},
	bypass: {
		get text() {
			return `⏵⏵⏵ permission: bypass · ${shortcutText("app.permission.cycle")}`;
		},
		short: "⏵⏵⏵ bypass",
		color: "warning",
	},
};

/** What full mode did this session: calls it allowed, and how many of them were ⚠ (destructive, browser control, private network). */
export interface ActionCount {
	actions: number;
	warnings: number;
}

/** The chip as parts, so the footer paints the mode and its shortcut apart: `{icon: "⏵⏵", mode: "full", counters: "12 actions · 2 ⚠", key: "shift+tab"}`. */
export interface ChipParts {
	icon: string;
	mode: PermissionMode;
	/** What full mode did this session; empty until a call ran, and always empty outside full and bypass. */
	counters: string;
	key: string;
}

const CHIP_ICONS: Record<PermissionMode, string> = { manual: "⏸", workspace: "", full: "⏵⏵", bypass: "⏵⏵⏵" };

/** The parts of `mode`'s chip; in full or bypass, once a call ran, the counters read `12 actions · 2 ⚠`. */
export function chipParts(mode: PermissionMode, count?: ActionCount): ChipParts {
	const counted = runsUnasked(mode) && count !== undefined && count.actions > 0;
	const warned = counted && count.warnings > 0 ? ` · ${count.warnings} ⚠` : "";
	return {
		icon: CHIP_ICONS[mode],
		mode,
		counters: counted ? `${plural(count.actions, "action")}${warned}` : "",
		key: shortcutText("app.permission.cycle"),
	};
}

/** `⏵⏵ permission: full · 12 actions · 2 ⚠` and the same without the icon or counters: what the chip says before its shortcut. */
export function chipLabel(parts: ChipParts): string {
	const label = `${parts.icon ? `${parts.icon} ` : ""}permission: ${parts.mode}`;
	return parts.counters ? `${label} · ${parts.counters}` : label;
}

/** The narrow form: `⏵⏵ full · 12 actions · 2 ⚠`, with no shortcut. */
export function chipShortLabel(parts: ChipParts): string {
	const short = CHIPS[parts.mode].short;
	return parts.counters ? `${short} · ${parts.counters}` : short;
}

/** The chip text of `mode`; in full or bypass, once a call ran, it counts them: `⏵⏵ permission: full · 12 actions · 2 ⚠ · Shift+Tab`. */
export function chipText(mode: PermissionMode, count?: ActionCount): string {
	const parts = chipParts(mode, count);
	return `${chipLabel(parts)} · ${parts.key}`;
}
