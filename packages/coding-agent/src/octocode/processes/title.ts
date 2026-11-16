import { APP_NAME } from "../../config.ts";
import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { AGENT_ID_ENV, AGENT_ROLE_ENV } from "../team/store/env.ts";

/**
 * Every Octocode process names itself `octocode-<role>-<id>` so `ps`, `pgrep -f` and `/processes` tell them apart: a
 * main session `octocode-main-<last 8 characters of its session id>`, an RPC host `octocode-rpc-<id>`, a subagent
 * `octocode-<role>-<agent id>`. The prefix is the executable name, so tools that match `octocode` still find it.
 *
 * Limits: macOS prints the whole title in `ps -o args` (checked up to 200 characters) and the first 15 in `comm`;
 * Linux keeps the title in the process's own argument area and `comm` takes its first 15 bytes too, so the part that
 * identifies the process comes early and the whole title stays short.
 */
export const MAX_TITLE_LENGTH = 64;
const SESSION_ID_LENGTH = 8;

export type SessionRole = "main" | "rpc";

const safe = (text: string): string => text.replace(/[^A-Za-z0-9._-]/g, "_");

/** `octocode-<role>-<id>`, safe characters only (a title is shown in a terminal), at most `MAX_TITLE_LENGTH` long; no id gives `octocode-<role>`. */
export function processTitle(role: string, id = ""): string {
	return [APP_NAME, safe(role), safe(id)].filter(Boolean).join("-").slice(0, MAX_TITLE_LENGTH);
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

/** Whether a `ps` command column is one of these titles (and not a path, which starts with `/` or has arguments of its own). */
export function isProcessTitle(command: string): boolean {
	return new RegExp(`^${APP_NAME}-[A-Za-z0-9._]+-[A-Za-z0-9._-]+(?:\\s|$)`).test(command);
}

/** The role and id a title names, for a process that has recorded nothing else. A role with a `-` in it reads as its first segment. */
export function parseTitle(command: string): { role: string; id: string } | undefined {
	const match = new RegExp(`^${APP_NAME}-([A-Za-z0-9._]+)-([A-Za-z0-9._-]+)(?:\\s|$)`).exec(command);
	return match ? { role: match[1], id: match[2] } : undefined;
}

export function setProcessTitle(title: string): void {
	process.title = title;
}
