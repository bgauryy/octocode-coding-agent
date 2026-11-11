import type { ParsedCommand, ParsedShell } from "../shared/shell-commands.ts";

/**
 * The commands the reservation gate lets run while another agent holds a path, even when an argument is a variable or a
 * glob the line does not spell out: readers with no write form of their own. The gate otherwise refuses such a command,
 * since a computed word may become an option that writes; for these the owner accepted that, because they were the
 * largest single cause of refused read-only work (RFC 2026-11-11 core tools, step B4).
 */
const READERS = new Set(["rg", "grep", "ls", "cat", "wc", "fd"]);
const GIT_READERS = new Set(["log", "diff", "show"]);

/** Options, spelled out on the line, that make one of these readers write a file or run a program. */
const WRITES_OR_RUNS: Record<string, RegExp> = {
	rg: /^--(?:pre|hostname-bin)(?:=|$)/,
	fd: /^(?:-[A-Za-z]*[xX]|--exec(?:-batch)?(?:=|$))/,
	git: /^--(?:output|ext-diff)(?:=|$)/,
};

/** A redirection that writes no file: a duplicated descriptor (`2>&1`) or output sent to `/dev/null`. */
const HARMLESS_REDIRECT = /^(?:\d*>&\d+|(?:\d*|&)>>?\s*\/dev\/null)$/;
/** A word that runs another command: `$(…)`, backticks, a process substitution. */
const RUNS_COMMAND = /\$\(|`|[<>]\(/;

function allowedReader(command: ParsedCommand): boolean {
	// The program is the first word: no assignment before it (`GIT_EXTERNAL_DIFF=x git diff`) and no wrapper.
	if (command.program !== 0) return false;
	const name = command.literals[0];
	if (name === undefined) return false;
	if (command.words.some((word) => RUNS_COMMAND.test(word))) return false;
	if (!command.redirects.every((redirect) => HARMLESS_REDIRECT.test(redirect.trim()))) return false;
	if (name === "git") {
		// The subcommand follows `git` at once: a global option (`-c core.pager=…`, `--exec-path`) could run a program.
		const sub = command.literals[1];
		if (sub === undefined || !GIT_READERS.has(sub)) return false;
	} else if (!READERS.has(name)) return false;
	const risky = WRITES_OR_RUNS[name];
	if (!risky) return true;
	// Only up to `--`: what follows it is an operand, whatever it looks like. Both spellings are read, the source text
	// (`--output="$X"` has no literal value) and the value after quotes are removed (`"--output=x"`).
	const end = command.literals.indexOf("--");
	const count = end === -1 ? command.words.length : end;
	for (let index = 1; index < count; index++) {
		const literal = command.literals[index];
		if (risky.test(command.words[index] ?? "") || (literal !== undefined && risky.test(literal))) return false;
	}
	return true;
}

/**
 * Whether every command of the line is one of the allowed readers, with nothing that runs another command, defines a
 * function or redirects to a file. An unparsed line is never allowed.
 */
export function onlyAllowedReaders(parsed: ParsedShell | undefined): boolean {
	if (!parsed || parsed.commands.length === 0 || parsed.functions.length > 0) return false;
	return parsed.commands.every(allowedReader);
}
