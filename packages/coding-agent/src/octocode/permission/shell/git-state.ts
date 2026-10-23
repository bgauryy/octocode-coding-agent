import { base, BODY, mask, SEPARATOR, SHELLS, shellScript, stdinOf, unhide, words } from "./words.ts";

/** `git` options before the subcommand that take the next word as their value (`git -C dir add`). */
const GIT_OPTION_ARGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"]);
/** `git stash` subcommands that only read. */
const STASH_READS = new Set(["list", "show", "create"]);
const DRY_RUN = new Set(["-n", "--dry-run"]);

/** The subcommand and its arguments of a `git …` command's words, past `git`'s own options. */
function gitCall(tokens: string[]): { sub: string; rest: string[] } | undefined {
	if (base(tokens[0] ?? "") !== "git") return undefined;
	let at = 1;
	while (at < tokens.length && tokens[at].startsWith("-")) at += GIT_OPTION_ARGS.has(tokens[at]) ? 2 : 1;
	const sub = tokens[at];
	return sub ? { sub, rest: tokens.slice(at + 1) } : undefined;
}

/**
 * The git index or history mutation one simple command's words make (`git add`, `git rm`, `git stash`, `git commit`,
 * `git reset`, `git checkout -- <path>`, `git restore`), else undefined. A dry run and the reading `git stash`
 * subcommands are not mutations.
 */
function mutationOf(tokens: string[]): string | undefined {
	const call = gitCall(tokens);
	if (!call) return undefined;
	const { sub, rest } = call;
	const dry = rest.some((token) => DRY_RUN.has(token));
	if ((sub === "add" || sub === "rm" || sub === "commit") && !dry) return `git ${sub}`;
	if (sub === "reset" || sub === "restore") return `git ${sub}`;
	if (sub === "stash") {
		const verb = rest.find((token) => !token.startsWith("-"));
		return verb !== undefined && STASH_READS.has(verb) ? undefined : `git stash${verb ? ` ${verb}` : ""}`;
	}
	// `git checkout -- <path>`, `git checkout <ref> -- <path>` and `git checkout .` overwrite files from the index or a ref.
	if (sub === "checkout" && (rest.includes("--") || rest.includes("."))) return "git checkout -- <path>";
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
		piped =
			name === "echo" || name === "printf"
				? [unhide(tokens.slice(1).join(" "))]
				: name === "cat"
					? stdinOf(tokens, bodies).map(unhide)
					: [];
		if (!name || BODY.test(name)) continue;
		const found = mutationOf(tokens.map(unhide));
		if (found) return found;
		const scripts: string[] = [];
		if (name === "eval") scripts.push(tokens.slice(1).map(unhide).join(" "));
		if (SHELLS.has(name)) {
			const shell = shellScript(tokens);
			if (shell.script !== undefined) scripts.push(unhide(shell.script));
			if (shell.stdin) scripts.push(...stdinOf(tokens, bodies).map(unhide), ...fromPipe);
		}
		for (const script of scripts) {
			const nested = gitStateMutation(script);
			if (nested) return nested;
		}
	}
	return undefined;
}
