import type { ConfigOp } from "./types.ts";
import { kindOf } from "./result.ts";

/**
 * Settings keys (a key and everything under it) whose change widens what a session may do, run or reach. The list
 * follows the guards that already treat them apart: `security` and `remote.autoStart` are global-only or never weakened
 * by a project (`core/settings-manager/merge.ts`), `sandbox` is the shell's confinement, `bash.inheritProviderKeys`
 * hands provider keys to shell children, `research.allowedPaths` opens folders to research, and the rest start or
 * reach programs, networks and other sessions.
 */
const SENSITIVE_SETTINGS: readonly string[] = [
	"permissions",
	"permissionMode",
	"sandbox",
	"hooks",
	"trust",
	"security",
	"remote",
	"retention",
	"research.allowedPaths",
	"bash.inheritProviderKeys",
	"sessionApi",
	"sessionApiTurnPermission",
	"externalAgents",
	"enabledExternalAgents",
	"externalModels",
	"shellPath",
	"shellCommandPrefix",
	"npmCommand",
	"httpProxy",
	"mcpExposure",
];

/** Entry kinds that define or start programs: every change to one carries the warning. */
const SENSITIVE_KINDS: ReadonlySet<string> = new Set(["mcp", "hook", "plugin", "harness"]);

const matches = (key: string, root: string): boolean => key === root || key.startsWith(`${root}.`);

/** Why a change to `id` needs the user's closest look, or undefined when it is an ordinary setting. */
export function sensitiveReason(id: string): string | undefined {
	const kind = kindOf(id);
	if (SENSITIVE_KINDS.has(kind))
		return `${kind} entries define or start programs and their credentials: this changes what runs on this machine`;
	if (kind !== "setting") return undefined;
	const root = SENSITIVE_SETTINGS.find((each) => matches(id, each));
	return root
		? `\`${root}\` controls permissions, confinement, credentials or reach: this widens or narrows what the agent may do`
		: undefined;
}

/** The warning for a write, or undefined when the entry is ordinary. */
export const sensitiveOp = (op: ConfigOp): string | undefined => sensitiveReason(op.id);
