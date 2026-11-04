import path from "node:path";
import { followingBareCd, underDirectory } from "../bash-cwd.ts";
import { bashSyntax } from "../bash-syntax.ts";
import type { BashCommand } from "../bash-types.ts";
import { bashCandidates } from "../bash-wrappers.ts";
import { homeSpelling } from "../file-access.ts";
import { gitLocation, optionValues } from "./destinations.ts";
import { gitOptionsEnd, operandsOf, SHELL_PROGRAMS, scriptOf, type Word } from "./program-forms.ts";
import { base, wrappedCommand } from "./words.ts";

/**
 * The git commands in a bash command line that land commits on a branch, and where they act, for the `worktree.merge`
 * ask (`permission/landing.ts`). Read through the bash parse: wrappers, lists, `cd`, `git -C`, `git -c`, `sh -c` and
 * `eval`. It is a guard against mistakes, not a boundary: a script, a git alias or a directory the parse cannot follow
 * is not seen, and the session's normal rules apply to it.
 */

/**
 * Each landing subcommand, with the options that start no landing: they manage one already under way (the ask came when
 * it started) or print. `pull --dry-run` stops after a dry fetch. `merge --no-commit`, `merge --squash` and
 * `cherry-pick -n` stay in, because the commit that follows them is an ordinary `git commit`.
 */
const LANDINGS: ReadonlyMap<string, readonly string[]> = new Map([
	["merge", ["--abort", "--continue", "--quit"]],
	["pull", ["--dry-run"]],
	["rebase", ["--abort", "--continue", "--skip", "--quit", "--edit-todo", "--show-current-patch"]],
	["cherry-pick", ["--abort", "--continue", "--skip", "--quit"]],
	["revert", ["--abort", "--continue", "--skip", "--quit"]],
	["am", ["--abort", "--continue", "--skip", "--quit", "--resolved", "-r", "--show-current-patch"]],
]);
const PRINTS = ["--help", "-h"];
/** `git switch` / `git checkout` options whose value names a branch made at that moment. */
const CREATES = new Set(["-b", "-B", "-c", "-C", "--create", "--force-create", "--orphan"]);
const MAX_NESTING = 4;

/** The branch an earlier `git switch` or `git checkout` on the same line leaves the checkout on. */
export interface SwitchedBranch {
	name: string;
	/** The line makes it (`-c`, `-b`), so no ref says it exists yet; a detached HEAD is one that no default branch matches. */
	created: boolean;
}

export interface GitLanding {
	/** `git merge`, `git pull`… */
	command: string;
	/** Where it acts, spelled as the line spells it: `""` is the command's own directory. It may be any of them, after a `cd a; …`. */
	dirs: string[];
	switchedTo?: SwitchedBranch;
}

const before = (words: Word[]): Word[] => {
	const end = words.indexOf("--");
	return end < 0 ? words : words.slice(0, end);
};

/** Whether a landing subcommand's words start one (no management or printing option). */
function startsLanding(sub: string, words: Word[]): boolean {
	const idle = [...(LANDINGS.get(sub) ?? []), ...PRINTS];
	return !before(words).some(
		(word) => word !== undefined && idle.some((form) => word === form || word.startsWith(`${form}=`)),
	);
}

/** The branch `git switch` / `git checkout` leaves HEAD on; undefined for one that restores paths or names no branch the line spells. */
function switchOf(words: Word[]): SwitchedBranch | undefined {
	if (words.includes("--") || words.includes(".")) return undefined;
	if (words.includes("--detach") || words.includes("-d")) return { name: "HEAD", created: true };
	const name = operandsOf(words)[0];
	return name === undefined ? undefined : { name, created: words.some((word) => CREATES.has(word ?? "")) };
}

/** `git rebase` options whose value is the next word, so it is not the upstream or the branch (`--onto x main feat`). */
const REBASE_VALUES = new Set([
	"--onto",
	"-s",
	"--strategy",
	"-X",
	"--strategy-option",
	"-x",
	"--exec",
	"-C",
	"--whitespace",
]);

/**
 * The branch `git rebase <upstream> <branch>` checks out first (`--root <branch>` has no upstream); undefined when the line
 * names none, so the rebase runs on the current branch.
 */
function rebaseBranch(words: Word[]): SwitchedBranch | undefined {
	const operands: Word[] = [];
	const options = before(words);
	for (let at = 0; at < options.length; at++) {
		const word = options[at];
		if (word !== undefined && REBASE_VALUES.has(word)) at++;
		else if (word === undefined || !word.startsWith("-")) operands.push(word);
	}
	const name = operands[options.includes("--root") ? 0 : 1];
	return name === undefined ? undefined : { name, created: false };
}

/** The checkout a `.git` folder belongs to; undefined for any other git directory, which says nothing about a checkout. */
const checkoutOfGitDir = (dir: string): string | undefined =>
	path.basename(dir) === ".git" ? path.dirname(dir) : undefined;

/** A `GIT_DIR=…` or `GIT_WORK_TREE=…` set for the command: its value, undefined when the shell computes it, `null` when unset. */
function setting(settings: readonly string[], name: string): Word | null {
	const found = settings.find((each) => each.startsWith(`${name}=`));
	if (found === undefined) return null;
	const value = found.slice(name.length + 1).replace(/^(["'])(.*)\1$/, "$2");
	return /[$`]/.test(value) ? undefined : value;
}

/** Where a git call acts: `-C`, `--work-tree` or `--git-dir` (or the variables for them) under the directories the line is in. Undefined when the parse cannot say. */
function gitDirs(command: BashCommand, globals: Word[], settings: readonly string[]): string[] | undefined {
	const location = gitLocation(globals);
	if (!command.dirs || location === undefined) return undefined;
	const named = (option: string, variable: string): Word | null => {
		const values = optionValues(globals, "", [option]);
		return values.length > 0 ? values[0] : setting(settings, variable);
	};
	const workTree = named("--work-tree", "GIT_WORK_TREE");
	const gitDir = named("--git-dir", "GIT_DIR");
	if (workTree === undefined || gitDir === undefined) return undefined;
	const checkout = workTree ?? (gitDir === null ? null : checkoutOfGitDir(gitDir));
	if (checkout === undefined) return undefined;
	const repository = checkout === null ? location : underDirectory(location, checkout);
	return command.dirs.map((dir) => (repository === "" ? dir : underDirectory(dir, repository)));
}

function landingsIn(script: string, depth: number, env: NodeJS.ProcessEnv): GitLanding[] {
	const found: GitLanding[] = [];
	/** The branch each checkout was last switched to on this line, by the directories it acts on. */
	const switched = new Map<string, SwitchedBranch>();
	for (const part of bashSyntax(depth === 0 ? followingBareCd(script, env) : script).commands) {
		const literals = part.tokens.map((word) => word.literal ?? homeSpelling(word.raw));
		const programs = new Set<number>();
		for (const index of bashCandidates(part, "deny").executables) {
			programs.add(index);
			const real = wrappedCommand(literals, index);
			if (real !== undefined) programs.add(real);
		}
		for (const at of programs) {
			const program = literals[at];
			if (program === undefined) continue;
			const name = base(program);
			const rest = literals.slice(at + 1);
			if (name === "git") {
				const end = gitOptionsEnd(rest);
				const sub = rest[end];
				if (sub === undefined) continue;
				const settings = [
					...part.assignments.map(({ raw }) => raw),
					...literals.slice(0, at).filter((word): word is string => word !== undefined),
				];
				const dirs = gitDirs(part, rest.slice(0, end), settings);
				if (!dirs) continue;
				const words = rest.slice(end + 1);
				const key = dirs.join("\0");
				if (sub === "switch" || sub === "checkout") {
					const branch = switchOf(words);
					if (branch) switched.set(key, branch);
				} else if (LANDINGS.has(sub) && startsLanding(sub, words)) {
					// `git rebase <upstream> <branch>` switches to `<branch>` first, and leaves HEAD there.
					const rebased = sub === "rebase" ? rebaseBranch(words) : undefined;
					if (rebased) switched.set(key, rebased);
					const branch = switched.get(key);
					found.push({ command: `git ${sub}`, dirs, ...(branch ? { switchedTo: branch } : {}) });
				}
			} else if (depth < MAX_NESTING && part.dirs && (SHELL_PROGRAMS.has(name) || name === "eval")) {
				const inner = name === "eval" ? (rest.includes(undefined) ? undefined : rest.join(" ")) : scriptOf(rest);
				if (inner === undefined) continue;
				const { dirs: outer } = part;
				for (const landing of landingsIn(inner, depth + 1, env))
					found.push({
						...landing,
						dirs: outer.flatMap((dir) => landing.dirs.map((each) => underDirectory(dir, each))),
					});
			}
		}
	}
	return found;
}

/**
 * The landing git commands of a bash line. A line the parser cannot read, or a git call whose directory it cannot place,
 * yields nothing. Synchronous: the caller awaits `shellParserReady` first (the gate does).
 */
export const gitLandings = (command: string, env: NodeJS.ProcessEnv = process.env): GitLanding[] =>
	landingsIn(command, 0, env);
