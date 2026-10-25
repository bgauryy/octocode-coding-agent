import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";

/** Environment switches: one spelling rule for every `OCTOCODE_*` flag and number. */

/** Set for a browser child with headless=false: Chrome uses a visible window and persistent profile. */
export const BROWSER_VISIBLE_ENV = "OCTOCODE_BROWSER_VISIBLE";

/** Set in a subagent: the session id of the Octocode session that started it, whose backlog claims the subagent may update. */
export const PARENT_SESSION_ENV = "OCTOCODE_PARENT_SESSION";
export const PARENT_TRANSCRIPT_ENV = "OCTOCODE_PARENT_TRANSCRIPT";

/** `1` runs Claude Code / Codex command hooks (off by default; subagents run them only when their profile opts in). */
export const HOOKS_ENV = "OCTOCODE_HOOKS";

/** Preview source-specific hook behavior; it does not imply complete upstream compatibility. */
export const HOOKS_COMPAT_ENV = "OCTOCODE_HOOKS_COMPAT";

/** `0` keeps the Octocode MCP server unregistered for this session and its children. */
export const MCP_ENV = "OCTOCODE_MCP";

/** `0` turns automatic memory injection off for this process (`/memory auto off` turns it off everywhere). */
export const MEMORY_AUTO_ENV = "OCTOCODE_MEMORY_AUTO";

/** Days kept output and bash logs survive in a kept session folder (default 30); `0` turns the session sweep off. */
export const CLEANUP_DAYS_ENV = "OCTOCODE_CLEANUP_DAYS";

/** Set in child processes so a subagent cannot spawn further subagents (and skips the root session's extras). */
export const SUBAGENT_ENV = "OCTOCODE_SUBAGENT";
/** Set for a subagent whose profile is read-only (`readOnly: true`): it investigates and reports, keeping source unchanged. */
export const READ_ONLY_ENV = "OCTOCODE_READ_ONLY";

/** A subagent's own handoff folder (`<workspace>/.octocode/tmp/agents/<id>`): long results go there as files, not into its report. */
export const AGENT_SCRATCH_ENV = "OCTOCODE_AGENT_SCRATCH";
/** Absolute path used as-is as the team workspace (e.g. a subagent in a git worktree joins its parent's team). */
export const TEAM_WORKSPACE_ENV = "OCTOCODE_TEAM_WORKSPACE";

/** Set for an isolated subagent: the parent's repository root, whose stored trust decision the worktree follows. */
export const TRUST_ROOT_ENV = "OCTOCODE_TRUST_ROOT";

/** `off`, `unfocused` (default: only while the terminal is in the background) or `always`: answer-ready notifications. */
export const NOTIFY_ENV = "OCTOCODE_NOTIFY";

/** `osc9`, `osc777`, `osc99` or `bel`; unset picks one from the terminal's variables. */
export const NOTIFY_METHOD_ENV = "OCTOCODE_NOTIFY_METHOD";

/** `0` turns the extra skill directories off everywhere. */
export const EXTRA_SKILLS_ENV = "OCTOCODE_EXTRA_SKILLS";

/** `manual`, `workspace` or `full`: the permission mode a session starts in (unset: full). Owned by the parent in a subagent. */
export const PERMISSION_ENV = "OCTOCODE_PERMISSION";

/** Set by the parent in a subagent: the action classes its `agent` spawn was allowed (comma-separated). */
export const PERMISSION_GRANTS_ENV = "OCTOCODE_PERMISSION_GRANTS";

/** Set by the parent in a subagent whose parent can ask a person: the child sends its approval dialogs to the parent (RPC) instead of denying them. */
export const PERMISSION_RELAY_ENV = "OCTOCODE_PERMISSION_RELAY";

/**
 * Set by the parent in each subagent: the path of an owner-only (0600) file holding a random per-child secret, never the
 * secret itself (an environment is readable through `ps eww` or `/proc/<pid>/environ`, and `delete process.env.X` does not
 * clear what the OS reports). The child's permission module reads the file once at start and unlinks it (`takeNonce`), then
 * puts the secret in every permission header and audit notification it sends, so the parent trusts only what carries it (a
 * dialog the model raised does not). The same secret signs the user's messages to that child (`team/proof.ts`), so the
 * child can tell them from a forged `user` row. The parent removes the file at the end of the run if the child never took it.
 *
 * Residual (out of scope): a process of the same user that can read this process's memory (a debugger, `gcore`) can still
 * recover the secret, and a same-user process that reads the file in the moments between the spawn and the child's first
 * read can too. The secret keeps the model's tools, a peer session and a sibling from forging; it is not a sandbox.
 */
export const PERMISSION_NONCE_FILE_ENV = "OCTOCODE_PERMISSION_NONCE_FILE";

/** Where this process keeps its nonce once it left the file and the environment: on `globalThis`, so a `/reload` (a fresh module, the file gone) still has it. */
const NONCE_SLOT = Symbol.for("octocode.permissionNonce");
const nonceStore = globalThis as { [NONCE_SLOT]?: string };
/** The same slot for an injected environment (tests, embedders): one per environment object. */
const injectedNonces = new WeakMap<NodeJS.ProcessEnv, string>();

/** The nonce this process took from its parent's file (`takeNonce`); undefined for a session that is no subagent, or before the take. */
export function ownNonce(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env === process.env ? nonceStore[NONCE_SLOT] : injectedNonces.get(env);
}

/**
 * Reads the nonce file named by `env` once, unlinks it, removes the variable (no process this one starts inherits it) and
 * keeps the secret in the process slot (`ownNonce`). Later calls return the kept secret. A missing or unreadable file gives
 * undefined: the child then sends no header or audit notification the parent would accept.
 */
export function takeNonce(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const file = env[PERMISSION_NONCE_FILE_ENV];
	delete env[PERMISSION_NONCE_FILE_ENV];
	if (file) {
		let nonce: string | undefined;
		try {
			nonce = fs.readFileSync(file, "utf8").trim() || undefined;
		} catch {
			// Gone or unreadable: nothing to keep.
		}
		try {
			fs.unlinkSync(file);
		} catch {
			// Already gone, or not ours to remove.
		}
		if (nonce !== undefined) {
			if (env === process.env) nonceStore[NONCE_SLOT] = nonce;
			else injectedNonces.set(env, nonce);
		}
	}
	return ownNonce(env);
}

/**
 * Whether `given` (untrusted, any type) is the secret `expected`, compared in constant time over equal-length buffers: the one
 * check every nonce and proof goes through (permission headers, audit notifications, user-message signatures). False for an
 * empty `expected`.
 */
export function sameSecret(expected: string, given: unknown): boolean {
	if (expected === "" || typeof given !== "string") return false;
	const [want, got] = [Buffer.from(expected), Buffer.from(given)];
	return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Conversation retention, read by octocode-ai and the cache warmer. Instruction retention is independent.
 * A value the user exported always wins.
 */
export const CACHE_RETENTION_ENV = "OCTOCODE_CACHE_RETENTION";

const TRUE = /^(1|true|on|yes)$/i;
const FALSE = /^(0|false|off|no)$/i;

/** `1|true|on|yes` → true, `0|false|off|no` → false (any case, surrounding space ignored); unset or anything else → `fallback`. */
export function envFlag(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
	const value = env[name]?.trim() ?? "";
	if (TRUE.test(value)) return true;
	if (FALSE.test(value)) return false;
	return fallback;
}

/**
 * One of `choices` from the environment (any case, surrounding space ignored): `{ value }`, `{ invalid }` with the raw
 * text when it is none of them, or undefined when unset or empty.
 */
export function envChoice<T extends string>(
	env: NodeJS.ProcessEnv,
	name: string,
	choices: readonly T[],
): { value: T } | { invalid: string } | undefined {
	const raw = env[name]?.trim() ?? "";
	if (raw === "") return undefined;
	const value = choices.find((choice) => choice === raw.toLowerCase());
	return value ? { value } : { invalid: raw };
}

/** A whole number from the environment, clamped to `[min, max]`; unset or not an integer → `fallback`. */
export function envInt(
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
	bounds: { min?: number; max?: number } = {},
): number {
	const value = env[name]?.trim() ?? "";
	if (!/^[+-]?\d+$/.test(value)) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Math.min(bounds.max ?? Number.POSITIVE_INFINITY, Math.max(bounds.min ?? Number.NEGATIVE_INFINITY, parsed));
}

export const SKILL_SNAPSHOT_FILE_ENV = "OCTOCODE_SKILL_SNAPSHOT_FILE";

/** Owner-only handoff of enabled, non-stopped extension MCP registrations; a child registers them at start (`mcp/session-servers.ts`). */
export const MCP_SESSION_SERVERS_FILE_ENV = "OCTOCODE_MCP_SESSION_SERVERS_FILE";
