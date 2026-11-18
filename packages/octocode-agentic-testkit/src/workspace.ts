import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { runProcess, type ProcessRun } from "./process.ts";
import type { SandboxOptions } from "./sandbox.ts";

/** One file of a snapshot. */
export interface WorkspaceFile {
	sha256: string;
	size: number;
	/** UTF-8 content of a text file up to `maxTextBytes`; absent for binary and larger files. */
	text?: string;
	/** A symbolic link's target, which is what `sha256` and `size` describe; links are never followed. */
	link?: string;
}

/** Files under `dir` by relative POSIX path, sorted. */
export interface WorkspaceSnapshot {
	dir: string;
	files: Record<string, WorkspaceFile>;
}

export interface SnapshotOptions {
	/** Globs over relative paths (see `globRegExp`); a matching directory is not entered. Replaces `DEFAULT_IGNORE`. */
	ignore?: string[];
	/** Text content is kept for files up to this size (default 64 KiB). */
	maxTextBytes?: number;
}

export interface WorkspaceDiff {
	added: string[];
	removed: string[];
	changed: string[];
}

export const DEFAULT_IGNORE = ["**/.git", "**/node_modules"];

/**
 * A glob over relative POSIX paths: `**` spans directories (`src/**`, `**\/*.ts`), `*` and `?` stay within one
 * segment, everything else is literal.
 */
export function globRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			i++;
			if (glob[i + 1] === "/") {
				i++;
				re += "(?:.*/)?";
			} else re += ".*";
		} else if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true });

function textOf(b: Buffer, max: number): string | undefined {
	if (b.length > max || b.includes(0)) return undefined;
	try {
		return utf8.decode(b);
	} catch (e) {
		if (e instanceof TypeError) return undefined;
		throw e;
	}
}

/** Hashes every file under `dir` (sha256, size, text for small text files); `.git` and `node_modules` are skipped. */
export function snapshotWorkspace(dir: string, o: SnapshotOptions = {}): WorkspaceSnapshot {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`workspace directory does not exist: ${dir}`);
	const ignore = (o.ignore ?? DEFAULT_IGNORE).map(globRegExp);
	const max = o.maxTextBytes ?? 64 * 1024;
	const files: Record<string, WorkspaceFile> = {};
	const walk = (rel: string): void => {
		for (const name of readdirSync(join(dir, rel)).toSorted()) {
			const path = rel ? `${rel}/${name}` : name;
			if (ignore.some((g) => g.test(path))) continue;
			const abs = join(dir, path);
			const st = lstatSync(abs);
			if (st.isDirectory()) walk(path);
			else if (st.isSymbolicLink()) {
				const link = readlinkSync(abs);
				files[path] = { sha256: sha256(link), size: Buffer.byteLength(link), link };
			} else if (st.isFile()) {
				const b = readFileSync(abs);
				const text = textOf(b, max);
				files[path] = { sha256: sha256(b), size: b.length, ...(text === undefined ? {} : { text }) };
			}
		}
	};
	walk("");
	return { dir, files };
}

/** What changed between two snapshots, each list sorted. */
export function diffWorkspace(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceDiff {
	const added: string[] = [];
	const changed: string[] = [];
	for (const [path, f] of Object.entries(after.files)) {
		const was = before.files[path];
		if (!was) added.push(path);
		else if (was.sha256 !== f.sha256 || was.link !== f.link) changed.push(path);
	}
	const removed = Object.keys(before.files).filter((p) => !(p in after.files));
	return { added: added.toSorted(), removed: removed.toSorted(), changed: changed.toSorted() };
}

export interface VerifierOptions {
	/** Laid over `{ PATH }` of this process. */
	env?: Record<string, string>;
	/** Default 120 s. */
	timeoutMs?: number;
	/** A file, relative to the workspace, where the verifier writes its reward (a number); removed before it runs. */
	rewardFile?: string;
	/** Runs the verifier in the process sandbox, since it executes what the agent wrote. */
	sandbox?: false | SandboxOptions;
}

export interface VerifierResult {
	/** Exit code 0 (not timed out), or a reward of at least 1 when the verifier wrote one. */
	pass: boolean;
	exitCode: number | null;
	timedOut: boolean;
	reward?: number;
	stdout: string;
	stderr: string;
}

/** A path under `dir` from a relative one; throws for an absolute path or one that leaves `dir`. */
export function insideWorkspace(dir: string, rel: string): string {
	const n = normalize(rel);
	if (isAbsolute(rel) || n === ".." || n.startsWith(`..${sep}`))
		throw new Error(`paths are relative to the workspace and stay inside it: ${rel}`);
	return join(dir, n);
}

function readReward(file: string): number | undefined {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (e) {
		if ((e as { code?: unknown }).code === "ENOENT") return undefined;
		throw e;
	}
	const reward = Number(raw.trim());
	if (raw.trim() === "" || !Number.isFinite(reward))
		throw new Error(`reward file ${file} holds no number: ${JSON.stringify(raw.slice(0, 80))}`);
	return reward;
}

/**
 * Runs a verifier (tests, a checker script) in `workspace` and grades the outcome: exit code 0 passes, or, when the
 * verifier writes `rewardFile`, a reward of at least 1. A reward file the agent left behind is removed first.
 */
export async function runVerifier(
	workspace: string,
	command: string,
	args: string[],
	o: VerifierOptions = {},
): Promise<VerifierResult> {
	if (!existsSync(workspace) || !statSync(workspace).isDirectory())
		throw new Error(`workspace directory does not exist: ${workspace}`);
	const rewardPath = o.rewardFile === undefined ? undefined : insideWorkspace(workspace, o.rewardFile);
	if (rewardPath) rmSync(rewardPath, { force: true });
	const env: Record<string, string> = { PATH: process.env.PATH ?? "", ...o.env };
	const run: ProcessRun = await runProcess(command, args, {
		env,
		cwd: workspace,
		timeoutMs: o.timeoutMs ?? 120_000,
		home: env.HOME ?? workspace,
		sandbox: o.sandbox ?? false,
	});
	const reward = rewardPath ? readReward(rewardPath) : undefined;
	const pass = !run.timedOut && (reward === undefined ? run.exitCode === 0 : reward >= 1);
	return {
		pass,
		exitCode: run.exitCode,
		timedOut: run.timedOut,
		...(reward === undefined ? {} : { reward }),
		stdout: run.stdout,
		stderr: run.stderr,
	};
}
