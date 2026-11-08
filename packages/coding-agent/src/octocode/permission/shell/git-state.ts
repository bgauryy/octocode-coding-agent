import { base, BODY, fedToPipe, mask, nestedScripts, SEPARATOR, unhide, words } from "./words.ts";

/** `git` options before the subcommand that take the next word as their value (`git -C dir add`). */
const GIT_OPTION_ARGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"]);
/** `git stash` subcommands that only read. */
const STASH_READS = new Set(["list", "show", "create"]);
const DRY_RUN = new Set(["-n", "--dry-run"]);
/** Subcommands that change the index, checked-out files or the current branch's history, unless run dry. */
const TREE_CHANGES = new Set(["add", "rm", "commit", "mv", "clean", "pull"]);
/** Subcommands that always commit or rewrite checked-out files (`--abort`/`--continue` still move the tree). */
const HISTORY_CHANGES = new Set(["reset", "restore", "merge", "rebase", "cherry-pick", "revert", "am"]);
/** `git switch` / `git checkout` options that create a branch from the next word, at HEAD unless a start point follows. */
const BRANCH_CREATE = new Set(["-c", "-C", "--create", "--force-create", "-b", "-B"]);

/**
 * Whether `git switch` / `git checkout` (with neither `--` nor `.`) moves HEAD or rewrites files: any operand does
 * (a branch, a start point, `-` or a path), as does `--orphan`; a bare call or a new branch at HEAD does not.
 */
function switchesTree(rest: string[]): boolean {
	if (rest.some((token) => token === "--orphan" || token.startsWith("--orphan="))) return true;
	const operands: string[] = [];
	for (let at = 0; at < rest.length; at++) {
		if (BRANCH_CREATE.has(rest[at])) at++;
		else if (rest[at] === "-" || !rest[at].startsWith("-")) operands.push(rest[at]);
	}
	return operands.length > 0;
}

/** The subcommand and its arguments of a `git …` command's words, past `git`'s own options. */
function gitCall(tokens: string[]): { sub: string; rest: string[] } | undefined {
	if (base(tokens[0] ?? "") !== "git") return undefined;
	let at = 1;
	while (at < tokens.length && tokens[at].startsWith("-")) at += GIT_OPTION_ARGS.has(tokens[at]) ? 2 : 1;
	const sub = tokens[at];
	return sub ? { sub, rest: tokens.slice(at + 1) } : undefined;
}

/**
 * The git index, history or checked-out tree mutation one simple command's words make (`git add`, `git commit`,
 * `git stash`, `git reset`, `git merge`, `git switch main`, `git checkout -- <path>`...), else undefined. A dry run, the
 * reading `git stash` subcommands and a new branch at HEAD (`git switch -c x`) are not mutations.
 */
function mutationOf(tokens: string[]): string | undefined {
	const call = gitCall(tokens);
	if (!call) return undefined;
	const { sub, rest } = call;
	const dry = rest.some((token) => DRY_RUN.has(token));
	if (TREE_CHANGES.has(sub) && !dry) return `git ${sub}`;
	if (HISTORY_CHANGES.has(sub)) return `git ${sub}`;
	if (sub === "stash") {
		const verb = rest.find((token) => !token.startsWith("-"));
		return verb !== undefined && STASH_READS.has(verb) ? undefined : `git stash${verb ? ` ${verb}` : ""}`;
	}
	// `git checkout -- <path>`, `git checkout <ref> -- <path>` and `git checkout .` overwrite files from the index or a ref.
	if (sub === "checkout" && (rest.includes("--") || rest.includes("."))) return "git checkout -- <path>";
	if ((sub === "checkout" || sub === "switch") && switchesTree(rest))
		return sub === "switch" ? "git switch" : "git checkout <ref>";
	return undefined;
}

/**
 * The first git index or history mutation `command` runs (`mutationOf`), past wrappers (`env`, `timeout`, `sudo`),
 * `VAR=value`, command chains (`&&`, `;`, pipes, `$(…)`), `eval` and the scripts of `bash -c`, a heredoc or `echo … | sh`;
 * else undefined. Like the destructive-command check it reads the command's words, so quoting tricks can get past it.
 */
export function gitStateMutation(command: string): string | undefined {
	const bodies: string[] = [];
	const parts = mask(command, bodies).split(SEPARATOR);
	let piped: string[] = [];
	for (let at = 0; at < parts.length; at += 2) {
		const tokens = words(parts[at]);
		const fromPipe = parts[at - 1] === "|" ? piped : [];
		const name = base(unhide(tokens[0] ?? ""));
		piped = fedToPipe(tokens, bodies);
		if (!name || BODY.test(name)) continue;
		const found = mutationOf(tokens.map(unhide));
		if (found) return found;
		for (const script of nestedScripts(name, tokens, bodies, fromPipe)) {
			const nested = gitStateMutation(script);
			if (nested) return nested;
		}
	}
	return undefined;
}
