import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { normalize, sep } from "node:path";
import type { ProcessRun } from "../process.ts";
import {
	globRegExp,
	insideWorkspace,
	type VerifierResult,
	type WorkspaceDiff,
	type WorkspaceSnapshot,
} from "../workspace.ts";
import { cannot, type Result } from "./shared.ts";

/** Relative path -> exact text, a RegExp the text must match, or `null` for "must not exist". */
export type WorkspaceExpectation = Record<string, string | RegExp | null>;

type Observed = { dir: string } | { snapshot: WorkspaceSnapshot };

function needDir(dir: string): string {
	return existsSync(dir) && statSync(dir).isDirectory() ? dir : cannot(`workspace directory does not exist: ${dir}`);
}

/** A directory, a `ProcessRun` (its `workspace`) or a `WorkspaceSnapshot`. */
function observe(received: unknown): Observed {
	if (typeof received === "string") return { dir: needDir(received) };
	const v = received as Partial<ProcessRun & WorkspaceSnapshot> | null;
	if (v && typeof v === "object") {
		if (typeof v.dir === "string" && v.files && typeof v.files === "object")
			return { snapshot: v as WorkspaceSnapshot };
		if (typeof v.workspace === "string") return { dir: needDir(v.workspace) };
	}
	return cannot("received value is not a workspace directory, ProcessRun or WorkspaceSnapshot");
}

const show = (s: string): string => JSON.stringify(s.length > 200 ? `${s.slice(0, 200)}...` : s);
const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** What is wrong with one expected path, or undefined when it holds. */
function check(at: Observed, rel: string, want: string | RegExp | null): string | undefined {
	let file: { sha256: string; text: string | undefined } | "missing" | "directory";
	if ("dir" in at) {
		const abs = insideWorkspace(at.dir, rel);
		if (!existsSync(abs)) file = "missing";
		else if (statSync(abs).isDirectory()) file = "directory";
		else {
			const b = readFileSync(abs);
			file = { sha256: sha256(b), text: b.toString("utf8") };
		}
	} else {
		insideWorkspace(at.snapshot.dir, rel);
		const entry = at.snapshot.files[normalize(rel).split(sep).join("/")];
		file = entry ? { sha256: entry.sha256, text: entry.text } : "missing";
	}
	if (want === null) return file === "missing" ? undefined : `${rel}: expected no file, but it exists`;
	if (file === "missing") return `${rel}: missing`;
	if (file === "directory") return `${rel}: is a directory`;
	if (typeof want === "string") {
		if (file.sha256 === sha256(want)) return undefined;
		return `${rel}: expected ${show(want)}, got ${file.text === undefined ? "content not kept in the snapshot" : show(file.text)}`;
	}
	if (file.text === undefined)
		return cannot(`no text for ${rel} in the snapshot (binary, a link or over maxTextBytes)`);
	return file.text.search(want) >= 0 ? undefined : `${rel}: expected to match ${String(want)}, got ${show(file.text)}`;
}

function needDiff(v: unknown): WorkspaceDiff {
	const d = v as Partial<WorkspaceDiff> | null;
	return d && Array.isArray(d.added) && Array.isArray(d.removed) && Array.isArray(d.changed)
		? (d as WorkspaceDiff)
		: cannot("received value is not a WorkspaceDiff (diffWorkspace)");
}

function needVerifier(v: unknown): VerifierResult {
	const r = v as Partial<VerifierResult> | null;
	return r && typeof r.pass === "boolean" && "exitCode" in r && typeof r.stdout === "string"
		? (r as VerifierResult)
		: cannot("received value is not a VerifierResult (runVerifier)");
}

const tail = (s: string): string => (s.length > 500 ? `...${s.slice(-500)}` : s);

export const workspaceMatchers = {
	/** Each path holds the exact text, matches the RegExp, or (`null`) does not exist. */
	toHaveWorkspace(received: unknown, expected: WorkspaceExpectation): Result {
		const at = observe(received);
		const entries = Object.entries(expected);
		if (!entries.length) throw new Error("toHaveWorkspace needs at least one path");
		const wrong = entries.flatMap(([p, want]) => check(at, p, want) ?? []);
		return {
			pass: wrong.length === 0,
			message: () =>
				wrong.length
					? `the workspace does not match:\n  ${wrong.join("\n  ")}`
					: `expected the workspace not to match, but all ${entries.length} path(s) did`,
		};
	},

	/** Every added, removed or changed path of a `WorkspaceDiff` matches one of the globs (see `globRegExp`). */
	toChangeOnly(received: unknown, globs: string[]): Result {
		const diff = needDiff(received);
		if (!Array.isArray(globs)) throw new Error("toChangeOnly takes an array of globs");
		const allowed = globs.map(globRegExp);
		const touched = [
			...diff.added.map((p) => ["added", p] as const),
			...diff.removed.map((p) => ["removed", p] as const),
			...diff.changed.map((p) => ["changed", p] as const),
		];
		const outside = touched.filter(([, p]) => !allowed.some((g) => g.test(p)));
		return {
			pass: outside.length === 0,
			message: () =>
				outside.length
					? `changed outside ${JSON.stringify(globs)}:\n  ${outside.map(([k, p]) => `${k} ${p}`).join("\n  ")}`
					: `expected a change outside ${JSON.stringify(globs)}, but ${touched.length ? `all ${touched.length} change(s) matched` : "nothing changed"}`,
		};
	},

	/** A `VerifierResult` (`runVerifier`) passed: exit code 0, or a reward of at least 1. */
	toPassVerifier(received: unknown): Result {
		const r = needVerifier(received);
		const how = `exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}${r.reward === undefined ? "" : `, reward ${r.reward}`}`;
		return {
			pass: r.pass,
			message: () =>
				r.pass
					? `expected the verifier to fail, but it passed (${how})`
					: `the verifier failed (${how})\n  stdout: ${tail(r.stdout)}\n  stderr: ${tail(r.stderr)}`,
		};
	},
};
