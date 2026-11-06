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
 * is not seen, and the session's normal rules apply to it. That includes a program word the shell computes (`$g merge`,
 * `${GIT} push . x:main`) or a shell alias: the result has no "uncertain" state, and the consumer (`permission/landing.ts`)
 * treats anything it cannot determine as no landing, so such a line yields nothing rather than a guess that would ask
 * on every `$cmd merge`.
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

/** A commit-ish no pathspec reads as: `HEAD~1`, `HEAD^`, `@{u}`, `ORIG_HEAD` or a hash. A bare `main` could be a file, so without a mode flag it is not one. */
const COMMITISH = /^(?:(?:HEAD|@)(?:[~^]\d*|@\{.*\})|[0-9a-f]{7,40}|(?:ORIG|FETCH|MERGE)_HEAD)/;
/** Options of `git push` and `git fetch` whose value is the next word, so it is not the remote (`git fetch --depth 1 . x:main`). */
const PUSH_VALUES = new Set([
	"--repo",
	"-o",
	"--push-option",
	"--receive-pack",
	"--exec",
	"--upload-pack",
	"--depth",
	"--deepen",
	"-j",
	"--jobs",
	"--shallow-since",
	"--shallow-exclude",
	"--refmap",
	"--filter",
	"--server-option",
]);
const RESET_MODES = new Set(["--hard", "--soft", "--mixed", "--merge", "--keep"]);
const HEADS = "refs/heads/";

/** The operands of `words` (before `--` and after it), leaving out each option's value for the options in `valued`. */
function operandsSkipping(words: Word[], valued: (option: string) => boolean): Word[] {
	const operands: Word[] = [];
	let options = true;
	for (let at = 0; at < words.length; at++) {
		const word = words[at];
		if (options && word === "--") options = false;
		else if (options && word !== undefined && valued(word)) at++;
		else if (!options || word === undefined || !word.startsWith("-")) operands.push(word);
	}
	return operands;
}

/** A branch a ref-moving command names, as the protected-branch check takes it: made at that moment, so no ref has to exist. */
const named = (name: string): SwitchedBranch => ({ name, created: true });
/** The branch name of a ref or refspec destination; undefined for any other ref (a tag, a remote-tracking ref, `refs/octocode/…`). */
const headOf = (ref: string): string | undefined =>
	ref.startsWith(HEADS) ? ref.slice(HEADS.length) : ref.startsWith("refs/") ? undefined : ref;

/** `git branch -f <name>`, and `-M`/`-C` (move or copy over `<new>`): the branch it resets. */
function branchMoved(words: Word[]): SwitchedBranch[] {
	const options = before(words);
	const shorts = options.filter((word): word is string => /^-[a-zA-Z]+$/.test(word ?? ""));
	const has = (letters: string, long: string[]): boolean =>
		shorts.some((word) => new RegExp(`[${letters}]`).test(word)) || options.some((word) => long.includes(word ?? ""));
	if (has("dD", ["--delete"])) return [];
	if (!has("fMC", ["--force"])) return [];
	const operands = operandsSkipping(words, (option) => option === "--set-upstream-to" || /^-[a-zA-Z]*u$/.test(option));
	const target = has("mMcC", ["--move", "--copy"]) ? operands.at(-1) : operands[0];
	return target === undefined ? [] : [named(target)];
}

/** `git update-ref <ref> <new>` (and `-d`): the branch a `refs/heads/…` ref names, or the current one for `HEAD`. Undefined entry: the current branch. */
function updateRefMoved(words: Word[]): (SwitchedBranch | undefined)[] {
	const ref = operandsSkipping(words, (option) => option === "-m")[0];
	if (ref === undefined) return [];
	if (ref === "HEAD") return before(words).includes("--no-deref") ? [] : [undefined];
	return ref.startsWith(HEADS) ? [named(ref.slice(HEADS.length))] : [];
}

/** `git push . <src>:<branch>` and `git fetch . <src>:<branch>`: the local branches the refspecs write. */
function localRefspecs(words: Word[]): SwitchedBranch[] {
	const [remote, ...specs] = operandsSkipping(words, (option) => PUSH_VALUES.has(option));
	if (remote !== "." && remote !== "./") return [];
	const deleting = before(words).some((word) => word === "--delete" || word === "-d");
	const moved: SwitchedBranch[] = [];
	for (const spec of specs) {
		if (spec === undefined) continue;
		const bare = spec.replace(/^\+/, "");
		const colon = bare.lastIndexOf(":");
		const target = colon >= 0 ? bare.slice(colon + 1) : deleting ? bare : "";
		const name = target === "" ? undefined : headOf(target);
		if (name) moved.push(named(name));
	}
	return moved;
}

/**
 * Whether `git reset` moves the branch: it names a commit-ish. A mode flag (`--hard`, `--soft`…) makes the operand a
 * commit; without one only a form no path reads as does. `reset`, `reset HEAD`, `reset -- path`, `reset -p` and
 * `reset --hard HEAD` only unstage or discard, so they are not it.
 */
function resetMoves(words: Word[]): boolean {
	const end = words.indexOf("--");
	if (end >= 0 && end < words.length - 1) return false;
	const options = before(words);
	if (options.some((word) => word === "-p" || word === "--patch" || word?.startsWith("--pathspec-from-file")))
		return false;
	const operands = operandsOf(options);
	const target = operands[0];
	if (operands.length === 0 || target === "HEAD" || target === "@") return false;
	if (options.some((word) => RESET_MODES.has(word ?? ""))) return true;
	return target !== undefined && COMMITISH.test(target);
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

/** Commands that move a branch without a merge: what they name (a branch, or undefined for the current one). Each lists only the forms that do, so `branch` or `reset` alone ask nothing. */
const REF_MOVES: ReadonlyMap<string, (words: Word[]) => (SwitchedBranch | undefined)[]> = new Map([
	["branch", branchMoved],
	["update-ref", updateRefMoved],
	["push", localRefspecs],
	["fetch", localRefspecs],
	["reset", (words) => (resetMoves(words) ? [undefined] : [])],
]);

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
					// `-B` and `-C` reset an existing branch to the start point, which moves it.
					if (branch && words.some((word) => word === "-B" || word === "-C" || word === "--force-create"))
						found.push({ command: `git ${sub} -B`, dirs, switchedTo: branch });
				} else if (REF_MOVES.has(sub)) {
					const current = switched.get(key);
					for (const moved of REF_MOVES.get(sub)!(words)) {
						const branch = moved ?? current;
						found.push({ command: `git ${sub}`, dirs, ...(branch ? { switchedTo: branch } : {}) });
					}
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
