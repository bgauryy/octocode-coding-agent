import { gitOptionsEnd, type Word } from "./program-forms.ts";
import { computedOption, GIT_READERS } from "./read-only.ts";

/**
 * How `mutation.ts` judges a git call beyond the list of commands that change the tree (`GIT_MUTATING`, which names what a
 * reservation has to know): whether it is a read a read-only role may run, and whether it moves a ref. The first list is
 * closed on purpose: a subcommand nobody wrote down here is not a read, whatever it does, so `git branch -D`,
 * `git update-ref -d` or `git gc --prune=now` need no entry to be refused.
 */

/**
 * Global options that change how a read looks or which checkout it reads, never what runs. `-c`, `--config-env` and
 * `--exec-path` can run a program; `--git-dir` and `--work-tree` point it at other state; none of them is listed.
 */
const ROLE_GLOBALS = new Set([
	"-C",
	"-P",
	"--no-pager",
	"--no-optional-locks",
	"--no-replace-objects",
	"--no-lazy-fetch",
	"--no-advice",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
	"--version",
	"-v",
	"--help",
	"-h",
]);

/** `-c` settings that change only how a read prints; any other can run a program (`core.pager`, `diff.external`). */
const PRINT_SETTING = /^(?:core\.quotepath|color\.[\w.-]+)=/i;
const CONFIG_READS = /^(?:--get|--get-all|--get-regexp|--get-urlmatch|--list|-l)$/;
const CONFIG_WRITES = /^(?:--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section|--edit|-e)$/;

/** The first global option of `rest` (git's words) a read-only role may not use, as written. */
export function gitRoleGlobal(rest: ReadonlyArray<Word>): string | undefined {
	const end = gitOptionsEnd(rest);
	for (let at = 0; at < end; at++) {
		const word = rest[at];
		// `-C $X` may expand to more words, as a computed option may.
		if (word === "-C" && rest[at + 1] !== undefined) at++;
		else if (word === "-c" && PRINT_SETTING.test(rest[at + 1] ?? "")) at++;
		else if (word === undefined || word === "-C" || !ROLE_GLOBALS.has(word)) return word ?? "a computed option";
	}
	return undefined;
}

/** The list-form options of `branch` and `tag`, each with what it needs: `operands`: it makes the next operands patterns, so nothing is created; `valued`: its value may be the next word. */
interface ListOption {
	operands?: boolean;
	valued?: boolean;
}
const FILTER: ListOption = { operands: true, valued: true };
const LISTING: Record<string, ListOption> = {
	"--all": {},
	"--remotes": {},
	"--verbose": {},
	"--show-current": {},
	"--color": {},
	"--no-color": {},
	"--column": {},
	"--no-column": {},
	"--abbrev": {},
	"--no-abbrev": {},
	"--ignore-case": {},
	"--omit-empty": {},
	"--list": { operands: true },
	"--contains": FILTER,
	"--no-contains": FILTER,
	"--merged": FILTER,
	"--no-merged": FILTER,
	"--points-at": FILTER,
	"--sort": FILTER,
	"--format": FILTER,
};

/**
 * Whether `git branch` or `git tag` with `words` only lists: every option is a listing one, and an operand (which would
 * name a new ref) comes only after an option that turns operands into patterns. `short` holds the listing letters.
 */
function onlyLists(words: ReadonlyArray<Word>, short: RegExp): boolean {
	let patterns = false;
	for (let at = 0; at < words.length; at++) {
		const word = words[at];
		if (word === undefined) return false;
		if (!word.startsWith("-")) {
			if (!patterns) return false;
			continue;
		}
		if (short.test(word)) {
			if (word.includes("l")) patterns = true;
			continue;
		}
		const [name = "", value] = word.split("=");
		const option = Object.hasOwn(LISTING, name) ? LISTING[name] : undefined;
		if (!option) return false;
		if (option.operands) patterns = true;
		if (option.valued && value === undefined) at++;
	}
	return true;
}

/** Whether `sub`, a git subcommand outside `GIT_READERS`, is one of the few that also has a form that only lists, and `words` (after it) is that form. */
function listForm(sub: string, words: ReadonlyArray<Word>, after: ReadonlyArray<Word>): boolean {
	const verb = after[0];
	switch (sub) {
		case "branch":
			return onlyLists(words, /^-[arvl]+$/);
		case "tag":
			return onlyLists(words, /^-(?:[il]+|n\d*)$/);
		case "remote":
			if (verb === undefined) return words.every((word) => word === "-v" || word === "--verbose");
			// `remote show <name>` asks the remote unless `-n` says not to.
			return verb === "get-url" || (verb === "show" && (after.length === 1 || words.includes("-n")));
		case "stash":
			return verb === "list" || verb === "show";
		case "worktree":
			return verb === "list";
		case "notes":
			return verb === undefined || verb === "list" || verb === "show";
		case "reflog":
			return verb === undefined || verb === "show";
		case "config":
			return (
				words.some((word) => CONFIG_READS.test(word ?? "")) && !words.some((word) => CONFIG_WRITES.test(word ?? ""))
			);
		case "format-patch":
			// It prints with exactly `--stdout`; without it, `mutation.ts` records the patches it writes.
			return words.includes("--stdout");
		default:
			return false;
	}
}

/**
 * Why this git call is not a read: `rest` are git's words (their source text in `raws`), `sub` and `after` its subcommand
 * and operands. Undefined for a bare `git --version` and a subcommand of `GIT_READERS` that no word can turn into a
 * writing option (`computedOption`) or a list form (`listForm`). `readerWritingOptions` judges the literal options of a
 * reader, and `gitDestinations` the output options of any subcommand, so they are not repeated here.
 */
export function gitUnread(
	rest: ReadonlyArray<Word>,
	raws: ReadonlyArray<string>,
	sub: Word,
	after: ReadonlyArray<Word>,
): string | undefined {
	const end = gitOptionsEnd(rest);
	if (sub === undefined) return end < rest.length ? "git with a computed subcommand" : undefined;
	const words = rest.slice(end + 1);
	if (GIT_READERS.has(sub))
		return computedOption("git", [sub, ...words], raws.slice(end)) === undefined
			? undefined
			: `git ${sub} with a word that may expand to an option`;
	return listForm(sub, words, after) ? undefined : `git ${sub}`;
}

/** Options that delete, rename or overwrite an existing branch; a tag's `-m` and `-c` are not these. */
const MOVES_BRANCH = /^(?:-[a-zA-Z]*[dDmMcCf]|--delete|--move|--copy|--force)(?:=|$)/;
const MOVES_TAG = /^(?:-[a-zA-Z]*[df]|--delete|--force)(?:=|$)/;
/** A `git fetch` or `git push` refspec that names the local ref to write. */
const WRITES_LOCAL_REF = /^\+?[^:]*:.+$/;
/** Plumbing that writes refs directly, and history tools that rewrite or drop what the shared refs point at. */
const REF_PLUMBING = new Set(["update-ref", "symbolic-ref", "filter-branch", "replace", "gc", "prune"]);

/**
 * The ref-moving command this git call is, for an isolated child (`isolated-tree.ts`), whose worktree shares every branch,
 * tag and stash with the main checkout: changing one there changes it for the parent as well, with no file to name.
 * Creating a new branch or tag is not one; nor is moving this worktree's own detached `HEAD`.
 */
export function gitRefMove(rest: ReadonlyArray<Word>, sub: Word, after: ReadonlyArray<Word>): string | undefined {
	if (sub === undefined) return undefined;
	const words = rest.slice(gitOptionsEnd(rest) + 1);
	const end = words.indexOf("--");
	const options = (end < 0 ? words : words.slice(0, end)).filter(
		(word): word is string => word !== undefined && word.startsWith("-"),
	);
	if (REF_PLUMBING.has(sub)) {
		// `symbolic-ref HEAD` only prints.
		if (sub === "symbolic-ref" && after.length < 2 && !options.some((word) => /^(?:-d|--delete)$/.test(word)))
			return undefined;
		return `git ${sub}`;
	}
	if (sub === "reflog") return after[0] === "expire" || after[0] === "delete" ? `git reflog ${after[0]}` : undefined;
	// `refs/stash` is shared, so a plain stash moves the child's work out of the worktree its saved ref is made from.
	if (sub === "stash")
		return ["list", "show", "apply"].includes(after[0] ?? "") ? undefined : `git stash ${after[0] ?? "push"}`.trim();
	if (sub === "branch" || sub === "tag") {
		const moved = options.find((word) => (sub === "branch" ? MOVES_BRANCH : MOVES_TAG).test(word));
		return moved ? `git ${sub} ${moved}` : undefined;
	}
	if (sub === "checkout" || sub === "switch") {
		const moved = options.find((word) => /^(?:-B|-C|--force-create)(?:=|$)/.test(word));
		return moved ? `git ${sub} ${moved}` : undefined;
	}
	if (sub === "fetch" || sub === "push") {
		// A push to `.` or a path lands in this repository; to a remote it does not.
		const local = sub === "push" && after[0] !== undefined && /^(?:\.{1,2}|\/.*|\.{1,2}\/.*|~.*)$/.test(after[0]);
		const refspec = after.slice(1).find((word) => word !== undefined && WRITES_LOCAL_REF.test(word));
		return (sub === "fetch" ? refspec : local && refspec) ? `git ${sub} ${refspec}` : undefined;
	}
	return undefined;
}
