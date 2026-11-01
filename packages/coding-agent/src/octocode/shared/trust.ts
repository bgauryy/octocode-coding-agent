import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "../../config.ts";
import type { ExtensionCommandContext, ExtensionContext } from "../../core/extensions/index.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../../core/trust-manager.ts";
import { atomicWriteFileSync } from "../../../../common/src/atomic-file.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { notify, type Subcommands, say, wordCompletions } from "./commands.ts";
import { envFlag, SUBAGENT_ENV, TRUST_ROOT_ENV } from "../../../../common/src/env.ts";
import { projectHookFiles } from "./home.ts";
import { describeProjectConfig, startsCommands, untrustedProjectNotice } from "./trust/describe.ts";
import { fingerprint, projectConfigFiles, projectMcpFiles, readForFingerprint, realPath } from "./trust/files.ts";
import { createdFrom } from "./trust/origin.ts";
import { isWorktreeOf, readStore, storeKey, storePath, withFileLock } from "./trust/store.ts";

/**
 * Project files that start commands or steer the agent (Claude Code / Codex / Octocode hooks, project `mcp.json` files, `.pi/agents`, `.octocode/agents`, `.claude/skills`, `.octocode/skills`) load only after an explicit trust decision. `ctx.isProjectTrusted()` alone is not one: Octocode (checked
 * against 0.x `hasTrustRequiringProjectResources`) reports a project trusted when it holds none of *Octocode's* protected
 * resources (`.pi/settings.json`, `.pi/extensions`, `.agents/skills`, …), so a clone with only a `.claude/settings.json`
 * would run its hooks without ever asking. A project is trusted here when the user accepted these exact files: the decision is
 * stored in `<Octocode home>/pi-trust.json` with a SHA-256 of their content, so a later change needs `/trust`
 * again. When Octocode really resolved trust (it has protected resources, or a saved `/trust` decision) and Octocode has no
 * decision yet, the files present then are recorded as trusted, unless a hooks file among them starts commands: the
 * user never saw those in Octocode's dialog, so they wait for `/trust`, which shows them. A later change is asked
 * about like any other.
 */

type ProjectContext = Pick<ExtensionContext, "cwd" | "hasUI" | "isProjectTrusted"> & {
	ui?: Pick<ExtensionContext["ui"], "notify">;
};

/**
 * Answers of `projectTrustNow` for a few seconds: a session start asks from four places (skills, hooks,
 * profiles, memory), and each answer re-reads and re-hashes the project's config files. A decision clears it. Positive answers are
 * memoized only when no hook-capable configuration is present; those files are always hashed afresh.
 */
const TRUST_MEMO_MS = 5_000;

/** One trust answer and what it was computed from: the gated files and their `fingerprint`. */
interface TrustState {
	value: boolean | undefined;
	files: string[];
	sha: string;
}

const trustMemo = new Map<string, { at: number; state: TrustState }>();

/**
 * The trust decision when it needs no question: `true`/`false`, or `undefined` when the user must be asked (project
 * files exist, Octocode did not decline, and no stored decision matches their current content).
 */
export function projectTrustNow(
	ctx: Pick<ProjectContext, "cwd" | "isProjectTrusted">,
	home?: string,
): boolean | undefined {
	return trustState(ctx, home).value;
}

/** `projectTrustNow` with the files it saw: the gated files are walked once per call, and hashed only on a memo miss. */
function trustState(
	ctx: Pick<ProjectContext, "cwd" | "isProjectTrusted">,
	home?: string,
	contents?: ReadonlyMap<string, string>,
): TrustState {
	const files = projectConfigFiles(ctx.cwd);
	const captured = contents && new Map([...contents].map(([file, text]) => [realPath(file), text]));
	if (captured && [...captured.keys()].some((file) => !files.includes(file))) return { value: false, files, sha: "" };
	const read = (file: string) => captured?.get(file) ?? readForFingerprint(file);
	// Keyed by the files' size and mtime too (a stat, not a read), so ordinary edits and added config files invalidate the memo.
	const stamp = files.map((file) => {
		const stat = fs.statSync(file, { throwIfNoEntry: false });
		return `${file}:${stat?.size}:${stat?.mtimeMs}`;
	});
	// Octocode's own decision (its `/trust`) and our store file (written by any process) are part of the key too.
	const store = fs.statSync(storePath(home), { throwIfNoEntry: false })?.mtimeMs;
	const trusted = ctx.isProjectTrusted();
	const decided = trustDecided(ctx.cwd);
	const memoKey = `${ctx.cwd}\0${process.env[TRUST_ROOT_ENV] ?? ""}\0${process.env[SUBAGENT_ENV] ?? ""}\0${home ?? ""}\0${trusted}\0${decided}\0${store}\0${stamp.join("|")}`;
	const now = Date.now();
	// A size and mtime stamp can miss a same-size rewrite within the window. A memoized refusal errs safe; a memoized
	// `true` for any hook-capable config could let a same-stat command insertion run unreviewed.
	const memo = trustMemo.get(memoKey);
	if (!contents && memo && now - memo.at < TRUST_MEMO_MS) return memo.state;
	for (const [key, entry] of trustMemo) if (now - entry.at >= TRUST_MEMO_MS) trustMemo.delete(key);
	const sha = fingerprint(files, undefined, read);
	const state = { value: computeTrust(ctx.cwd, files, sha, trusted, decided, home, read), files, sha };
	const commandFiles = new Set([...projectHookFiles(ctx.cwd).map(realPath), ...projectMcpFiles(ctx.cwd)]);
	if (!contents && (state.value !== true || !files.some((file) => commandFiles.has(file)))) {
		trustMemo.set(memoKey, { at: now, state });
	}
	return state;
}

/**
 * This process is an isolated subagent working in a linked worktree of the repository at `OCTOCODE_TRUST_ROOT`, which
 * its parent sets only when it trusts that repository: the parent's trust covers the worktree, a path Octocode never saw.
 */
function inheritsTrust(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const root = env[TRUST_ROOT_ENV];
	return Boolean(
		root && path.isAbsolute(root) && envFlag(env, SUBAGENT_ENV) && isWorktreeOf(storeKey(cwd), realPath(root)),
	);
}

/**
 * `cwd` is a worktree Octocode created (`trust/origin.ts`) and holds exactly the gated files the user trusted in the main
 * checkout it came from. The decision is read from the main checkout each time, never copied: `/trust off` there, or a
 * changed file here, takes it away.
 */
function followsMain(cwd: string, files: string[], home: string | undefined, read: (file: string) => string): boolean {
	const root = storeKey(cwd);
	const main = createdFrom(root, home);
	const stored = main && readStore(home)[storeKey(main)];
	return Boolean(
		main &&
		stored &&
		stored.trusted &&
		stored.sha === fingerprint(files, (file) => path.join(main, path.relative(root, file)), read),
	);
}

function computeTrust(
	cwd: string,
	files: string[],
	sha: string,
	trusted: boolean,
	decided: boolean,
	home?: string,
	read: (file: string) => string = readForFingerprint,
): boolean | undefined {
	// An isolated subagent works in a worktree of its parent's repository: it follows the decision stored for that
	// repository, and only for the same files (no one can be asked in a subagent, so anything else stays closed).
	const inherited = process.env[TRUST_ROOT_ENV];
	if (inherited && path.isAbsolute(inherited)) {
		const parent = realPath(inherited);
		const root = storeKey(cwd);
		if (!inheritsTrust(cwd)) return files.length === 0;
		const stored = readStore(home)[parent];
		return (
			files.length === 0 ||
			(stored?.trusted &&
				stored.sha === fingerprint(files, (file) => path.join(parent, path.relative(root, file)), read))
		);
	}
	if (!trusted && files.length > 0) return false;
	const stored = trusted ? readStore(home)[storeKey(cwd)] : undefined;
	if (stored?.sha === sha) return stored.trusted;
	if (files.length > 0 && followsMain(cwd, files, home, read)) return true;
	// Octocode's trust covers the files present now (even none); recording them makes a later change, such as a pulled
	// hooks file, ask again. Hooks that start commands were never shown by Octocode: they need `/trust`.
	if (!stored && trusted && decided && !startsCommands(cwd, files, read)) {
		saveDecision(cwd, sha, true, home);
		return true;
	}
	return files.length === 0 ? true : undefined;
}

/** Octocode resolved trust itself: protected resources exist, or `/trust` saved a decision. */
function trustDecided(cwd: string): boolean {
	try {
		return hasTrustRequiringProjectResources(cwd) || new ProjectTrustStore(getAgentDir()).get(cwd) === true;
	} catch {
		return false;
	}
}

/** Projects (by path and content) already told they are skipped, so every loader shares one notice. */
const noticed = new Set<string>();

/** Whether this session already told its user that project config is not loaded (a subagent's same notice adds nothing). */
export function trustNoticeShown(): boolean {
	return noticed.size > 0;
}

/**
 * Whether trust-gated project files may load. An undecided project is skipped with one notice pointing at
 * `/trust`, which shows exactly what would run and asks. Startup never opens a dialog: Octocode (checked against
 * 0.x) ends an RPC session when a dialog is answered inside `session_start`, and print, JSON and subagent runs have
 * no one to ask.
 */
export async function projectTrust(ctx: ProjectContext, home?: string): Promise<boolean> {
	const { value, files, sha } = trustState(ctx, home);
	if (value !== undefined) return value;
	const key = `${storeKey(ctx.cwd)}\0${sha}`;
	if (!noticed.has(key)) {
		noticed.add(key);
		// A subagent has no /trust (it is registered in the main session only): the user decides there. A stored decision
		// that no longer matches means the files changed since the user last answered.
		const notice = untrustedProjectNotice(ctx.cwd, files, {
			changed: Boolean(readStore(home)[storeKey(ctx.cwd)]),
			subagent: envFlag(process.env, SUBAGENT_ENV),
		});
		if (ctx.ui) notify(ctx.ui, notice, "warning");
	}
	return false;
}

/**
 * Record a decision for the project files whose `fingerprint` is `sha` (the ones the user was shown). Other sessions
 * write the same store, so the read, merge and write happen under its lock.
 */
export function saveDecision(cwd: string, sha: string, trusted: boolean, home?: string): void {
	trustMemo.clear();
	const key = storeKey(cwd);
	const file = storePath(home);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	withFileLock(file, (assertHeld) => {
		const store = readStore(home);
		store[key] = { sha, trusted };
		assertHeld();
		atomicWriteFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
	});
}

/** `/trust [off]`: show what the project would run and trust (or distrust) exactly that, then reload. */
export function registerTrustCommand(commands: Subcommands, home?: string): void {
	commands.add("trust", {
		description: "Trust or distrust project config",
		argumentHint: "[off]",
		complete: (prefix) => wordCompletions(["off"], prefix),
		handler: async (args, ctx: ExtensionCommandContext) => {
			const action = args.trim();
			if (action !== "" && action !== "off") return say(ctx, "Usage: /trust [off]", "warning");
			let files = projectConfigFiles(ctx.cwd);
			if (files.length === 0) return say(ctx, "This project has no hook, MCP, agent or skill config to trust.");
			const off = action === "off";
			if (!off && !ctx.isProjectTrusted())
				return say(ctx, "Trust this project's resources first with /trust project.", "warning");
			// The decision covers exactly what was shown: fingerprinted before the dialog and re-checked after it.
			// Trust is a decision about what will run: without a terminal there is no review, so there is no trust.
			if (!off && !ctx.hasUI)
				return say(
					ctx,
					"Trusting project config needs a review: run /trust config in the interactive terminal.",
					"warning",
				);
			let sha = fingerprint(files);
			let details = describeProjectConfig(ctx.cwd, files);
			for (let attempt = 1; !off && ctx.hasUI; attempt++) {
				const yes = await ctx.ui.confirm(
					"Trust this project's config?",
					`${details}\n\nLoad and run these? You'll be asked again if they change.`,
				);
				if (!yes) return say(ctx, "Project config stays unloaded.");
				files = projectConfigFiles(ctx.cwd);
				const now = fingerprint(files);
				if (now === sha) break;
				if (attempt >= MAX_TRUST_ASKS)
					return say(
						ctx,
						"Project config kept changing while you reviewed it; it stays unloaded. Run /trust again.",
						"warning",
					);
				say(ctx, "Project config changed while you reviewed it; review it again.", "warning");
				sha = now;
				details = describeProjectConfig(ctx.cwd, files);
			}
			saveDecision(ctx.cwd, sha, !off, home);
			say(ctx, `${off ? "Distrusted" : "Trusted"} ${files.length} project files. Reloading…`);
			await ctx.reload();
		},
	});
}

/** Dialogs shown before giving up on config that keeps changing under review. */
const MAX_TRUST_ASKS = 3;

/** Verify the same settings bytes the caller will parse against the existing project trust fingerprint. */
export async function projectTrustForContents(
	ctx: ProjectContext,
	contents: ReadonlyMap<string, string>,
	home?: string,
): Promise<boolean> {
	return trustState(ctx, home, contents).value === true;
}

/** Advance an existing exact-file approval only across the staged permission fields. */
export function preparePermissionTrustUpdate(
	ctx: Pick<ProjectContext, "cwd" | "isProjectTrusted">,
	updates: ReadonlyMap<string, { before?: string; after: string }>,
	home?: string,
): (written: readonly string[]) => boolean {
	const files = projectConfigFiles(ctx.cwd);
	const before = new Map(files.map((file) => [file, readForFingerprint(file)]));
	const originalSha = fingerprint(files, undefined, (file) => before.get(file)!);
	const key = storeKey(ctx.cwd);
	const prior = readStore(home)[key];
	if (!ctx.isProjectTrusted() || !prior?.trusted || prior.sha !== originalSha) return () => false;
	const permitted = new Set(projectHookFiles(ctx.cwd).map(realPath));
	const changes = new Map<string, { before?: string; after: string }>();
	const withoutPermissions = (text: string | undefined) => {
		const parsed: unknown = text === undefined ? {} : JSON.parse(text);
		if (!isRecord(parsed)) throw new Error("Invalid permission settings object");
		const permissions = parsed.permissions;
		if (permissions !== undefined && !isRecord(permissions)) throw new Error("Invalid permissions object");
		const rest = { ...permissions };
		for (const field of ["allow", "deny", "ask", "defaultMode", "additionalDirectories"]) delete rest[field];
		return JSON.stringify({ ...parsed, permissions: rest });
	};
	for (const [file, change] of updates) {
		const canonical = realPath(file);
		if (!permitted.has(canonical)) continue;
		if (before.get(canonical) !== change.before) return () => false;
		try {
			if (withoutPermissions(change.before) !== withoutPermissions(change.after)) return () => false;
		} catch {
			return () => false;
		}
		changes.set(canonical, change);
	}
	return (written) => {
		const expected = new Map(before);
		let changed = false;
		for (const file of written) {
			const canonical = realPath(file),
				change = changes.get(canonical);
			if (change) {
				expected.set(canonical, change.after);
				changed = true;
			}
		}
		if (!changed) return false;
		const expectedFiles = [...expected.keys()].sort();
		const actualFiles = projectConfigFiles(ctx.cwd);
		if (
			JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles) ||
			expectedFiles.some((file) => readForFingerprint(file) !== expected.get(file))
		)
			return false;
		const nextSha = fingerprint(expectedFiles, undefined, (file) => expected.get(file)!);
		const storeFile = storePath(home);
		let advanced = false;
		withFileLock(storeFile, (assertHeld) => {
			const store = readStore(home);
			if (!store[key]?.trusted || store[key]?.sha !== originalSha) return;
			store[key] = { sha: nextSha, trusted: true };
			assertHeld();
			atomicWriteFileSync(storeFile, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
			trustMemo.clear();
			advanced = true;
		});
		return advanced;
	};
}
