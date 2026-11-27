import { AGENT_ID_ENV, AGENT_ROLE_ENV, envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { escapeRegExp } from "@octocodeai/octocode-common/regexp";

/**
 * Every Octocode process names itself `octocode-agent-<role>-<id>` so `ps`, `pgrep -f` and `/processes` tell them
 * apart: a main session `octocode-agent-main-<last 8 characters of its session id>`, an RPC host
 * `octocode-agent-rpc-<id>`, the web daemon `octocode-agent-web-<pid>`, a subagent `octocode-agent-<role>-<agent id>`. The prefix starts with the executable
 * name, so tools that match `octocode` still find it. Readers identify a process by its whole title (`ps -o args`),
 * never by `comm`, whose first 15 bytes hold only the prefix.
 *
 * Limits: macOS prints the whole title in `ps -o args` (checked up to 200 characters); Linux keeps it in the process's
 * own argument area, so the whole title stays short.
 */
export const MAX_TITLE_LENGTH = 64;

/** What every title starts with. */
// A fixed identity: a leaf module cannot read the host's configured app name, and every reader of a title shares this one.
export const TITLE_PREFIX = "octocode-agent";
const PREFIX = escapeRegExp(TITLE_PREFIX);
const TITLE = new RegExp(`^${PREFIX}-([A-Za-z0-9._]+)-([A-Za-z0-9._-]+)(?:\\s|$)`);
const BARE_TITLE = new RegExp(`^${PREFIX}-(main|rpc)(?:\\s|$)`);
const SESSION_ID_LENGTH = 8;

export type SessionRole = "main" | "rpc";

/** The user-level web daemon's role: one process per user, serving every session, so its id is its own pid. */
export const WEB_DAEMON_ROLE = "web";

/** Whether a listed process is the web daemon: its title carries its own pid, which a subagent's agent id does not. */
export const isWebDaemonTitle = (title: string, pid: number): boolean =>
	title === processTitle(WEB_DAEMON_ROLE, String(pid));

const safe = (text: string): string => text.replace(/[^A-Za-z0-9._-]/g, "_");

/** `octocode-agent-<role>-<id>`, safe characters only (a title is shown in a terminal), at most `MAX_TITLE_LENGTH` long; no id gives `octocode-agent-<role>`. */
export function processTitle(role: string, id = ""): string {
	return [TITLE_PREFIX, safe(role), safe(id)].filter(Boolean).join("-").slice(0, MAX_TITLE_LENGTH);
}

/**
 * The part of a session id a title shows: its last 8 characters. A UUIDv7 begins with a timestamp whose first 8
 * characters change only about once a minute, so sessions started together would share them; the tail is random.
 */
export function sessionTitleId(sessionId: string): string {
	return sessionId.slice(-SESSION_ID_LENGTH);
}

/** The title of a main or RPC process for the session it runs now. */
export function sessionProcessTitle(role: SessionRole, sessionId: string): string {
	return processTitle(role, sessionTitleId(sessionId));
}

/**
 * The subagent a process was started as, from the environment its parent set (`undefined` for a top-level process).
 * `OCTOCODE_SUBAGENT` is checked first: a process that merely inherited the agent variables is not that agent.
 */
export function subagentIdentity(env: NodeJS.ProcessEnv): { role: string; id: string } | undefined {
	if (!envFlag(env, SUBAGENT_ENV)) return undefined;
	return { role: env[AGENT_ROLE_ENV]?.trim() || "agent", id: env[AGENT_ID_ENV]?.trim() || String(process.pid) };
}

/**
 * The title a process starts with, before any session exists: a subagent's final one, and for the others the role
 * alone (`sessionProcessTitle` adds the id once the session starts). `role` is `rpc` for the RPC entry point.
 */
export function initialTitle(env: NodeJS.ProcessEnv, role: SessionRole): string {
	const subagent = subagentIdentity(env);
	return subagent ? processTitle(subagent.role, subagent.id) : processTitle(role);
}

/** Whether a `ps` command column is one of these titles, the id-less `octocode-agent-main` and `octocode-agent-rpc` of a starting process included (and not a path, which starts with `/` or has arguments of its own). */
export function isProcessTitle(command: string): boolean {
	return TITLE.test(command) || BARE_TITLE.test(command);
}

/** Whether `name` is the title of a main session or RPC host with its id (`octocode-agent-main-<id>`), not an agent id. */
export function isSessionTitle(name: string): boolean {
	const role = TITLE.exec(name)?.[1];
	return role === "main" || role === "rpc";
}

/** The role and id a title names, for a process that has recorded nothing else. A role with a `-` in it reads as its first segment. */
export function parseTitle(command: string): { role: string; id: string } | undefined {
	const match = TITLE.exec(command);
	if (match) return { role: match[1], id: match[2] };
	const bare = BARE_TITLE.exec(command);
	return bare ? { role: bare[1], id: "" } : undefined;
}

/**
 * Name this process `title`. On macOS every change also checks the process in with LaunchServices (Node's libuv loads
 * two system frameworks each time: about 10 ms the first time, 4-6 ms after), so a title the process already has is not
 * set again; a subagent starts with its final title.
 */
export function setProcessTitle(title: string): void {
	if (process.title === title) return;
	process.title = title;
}
