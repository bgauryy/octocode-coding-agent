import type { ExternalUsage } from "@octocodeai/octocode-contracts/external";
import type { RunnerBilling } from "../runners.ts";

/** The turn's outcome, as an ACP turn would report it. */
export interface HeadlessReply {
	text: string;
	stopReason?: string;
	usage?: ExternalUsage;
	cost?: number;
	billing?: RunnerBilling;
	/** The CLI's own id of the session this turn ran in, when its event stream named one: a later turn resumes it. */
	sessionId?: string;
}

/** A failure a vendor CLI reports as its sign-in: the caller drops the cached check, as for ACP `auth_required`. */
export class HeadlessSignedOut extends Error {}

/** What a parser needs from its turn: the runner, its billing, the task folders (paths show relative) and the row. */
export interface ParserInput {
	runner: string;
	billing?: RunnerBilling;
	/** The task folder as given and as the CLI sees it (symlinks resolved). */
	roots: readonly string[];
	onActivity(line: string): void;
}

/** Reads one vendor's event stream: one parsed JSON object per line, then the reply once the process closed. */
export interface HeadlessParser {
	line(event: Record<string, unknown>): void;
	/** The terminal event arrived: the turn is over and a held-open input may close. */
	readonly done: boolean;
	/** The reply; a failed run throws, a signed-out one as `HeadlessSignedOut`. */
	reply(code: number | null, stderr: string): HeadlessReply;
}

/**
 * `isolated`: the task runs in its own worktree; otherwise it runs in the session's own folder. `readOnly`: the caller
 * is a read-only role, so the task may not change files wherever it runs.
 */
interface PermissionScope {
	isolated: boolean;
	readOnly?: boolean;
}

/** A resumed turn's arguments: `args` join the permission and model arguments; `trailing` ends the argv (before any task argument). */
export interface ResumeArgs {
	args: string[];
	trailing?: string[];
}

/** How the task text reaches the CLI: a stream-json user event (input held open until the result), plain stdin, or the last argument. */
type TaskDelivery = "json" | "text" | "argv";

/**
 * One vendor CLI's headless route: its argv, how the task reaches it, the permission mapping, and its event parser.
 * Argv and parsers were written from the vendor's documented output and the CLI's `--help` at `tested`.
 */
export interface HeadlessRoute {
	id: string;
	/** The row's word for this route in `/providers`. */
	label: string;
	/** The CLI version whose flags and event schema the route was checked against. */
	tested: string;
	/** False: argv and parser exist, but Octocode cannot bound what the CLI may do, so no task runs through it. */
	enabled: boolean;
	/** The fixed part of the command, before communication, permission and model arguments. */
	args: readonly string[];
	/** Environment variables the route sets after the cleaned environment. */
	env: Readonly<Record<string, string>>;
	task: TaskDelivery;
	/** Whether the runner's communication bridge can be injected in this mode. */
	communication: boolean;
	/** The permission arguments for a scope; `refuse` says why the scope may not run. Never an unrestricted mode. */
	permission(scope: PermissionScope): { args: string[]; env?: Record<string, string> } | { refuse: string };
	model(model: string): string[];
	/** The arguments that continue the CLI's own session `sessionId` (a checked id), or why this CLI cannot resume one. */
	resume(sessionId: string): ResumeArgs | { refuse: string };
	parser(input: ParserInput): HeadlessParser;
}
