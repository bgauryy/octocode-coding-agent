import { mask, SEPARATOR, unhide, words } from "./words.ts";

/** Programs that only read and print: running one again gives the same view of the same state, and writes nothing. */
const READERS = new Set([
	"cat",
	"head",
	"tail",
	"ls",
	"wc",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"nl",
	"stat",
	"file",
	"du",
	"df",
	"pwd",
	"echo",
	"printf",
	"which",
	"diff",
	"cmp",
	"uniq",
	"cut",
	"tr",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"tree",
	"jq",
	"column",
	"sort",
	"find",
	"md5sum",
	"shasum",
	"sha256sum",
	"date",
	"uname",
	"whoami",
	"id",
	"cd",
	"true",
	"false",
	"test",
	"[",
]);
/** Whether an option token makes a reader run another program or write a file. */
type OptionTest = (option: string) => boolean;
/** A long option by any unambiguous-looking abbreviation (`--out`, `--output=x`): getopt and git accept them, so an exact match would miss them. */
const long =
	(...names: string[]): OptionTest =>
	(option) => {
		if (!option.startsWith("--")) return false;
		const flag = option.slice(2).split("=")[0];
		return flag !== "" && names.some((name) => name.startsWith(flag));
	};
/** A short option anywhere in a cluster (`-ro`), or one with its value attached (`-ofile`): either way the letter is in the token. */
const short = (letters: string): OptionTest => {
	const cluster = new RegExp(`^-[a-zA-Z0-9]*[${letters}]`);
	return (option) => cluster.test(option);
};
const exact =
	(...options: string[]): OptionTest =>
	(option) =>
		options.includes(option);
const anyOf =
	(...tests: OptionTest[]): OptionTest =>
	(option) =>
		tests.some((test) => test(option));

/** Options that make a reader run another program or write a file. */
const WRITING_OPTIONS: Record<string, OptionTest> = {
	find: exact("-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"),
	sort: anyOf(short("o"), long("output", "compress-program")),
	rg: anyOf(long("pre", "hostname-bin")),
	tree: short("o"),
	file: anyOf(short("C"), long("compile")),
	date: anyOf(short("s"), long("set")),
	// `-O<pager>` runs a program on the matches, `--ext-diff` and `--textconv` run the configured filters, `--output` and `-o` write a file.
	git: anyOf(exact("-o"), short("O"), long("output", "ext-diff", "textconv", "open-files-in-pager")),
};
/** `uniq` writes its result to a second operand; its value-taking options (`-f 2`) are not operands. */
const UNIQ_VALUED = new Set(["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"]);
const writesOperand = (options: string[]): boolean => {
	let operands = 0;
	for (let at = 0; at < options.length; at++) {
		const option = options[at];
		if (UNIQ_VALUED.has(option)) at++;
		else if (!option.startsWith("-") || option === "-") operands++;
	}
	return operands > 1;
};
/** `git` subcommands that only read the repository. */
const GIT_READERS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"rev-list",
	"describe",
	"shortlog",
	"grep",
	"cat-file",
	"show-ref",
]);
/** Redirections that write nowhere: to a file descriptor (`2>&1`), or to exactly `/dev/null` (not `/dev/nullx`, not `/dev/null/../x`). */
const HARMLESS_REDIRECT = /(?:&|\d*)>>?\s*(?:&\d+|\/dev\/null)(?=\s|$)/g;

/**
 * Whether every command `command` runs only reads: each simple command (in a pipeline, after `&&` or `;`, in a
 * substitution, or behind a wrapper such as `sudo` or `xargs`) is a program of `READERS` or a read-only `git`
 * subcommand, without an option that writes a file or runs another program (`WRITING_OPTIONS`, abbreviations
 * included), and nothing is redirected but to a file descriptor or `/dev/null`. A command the list does not know is
 * not read-only, and neither is a shell given a script (`sh -c`) or `uniq` given an output operand. A policy for what
 * may be left out of the context (its output can be had again), not a security check.
 */
export function readOnlyCommand(command: string): boolean {
	const bodies: string[] = [];
	const parts = mask(command, bodies).replace(HARMLESS_REDIRECT, " ").split(SEPARATOR);
	let commands = 0;
	for (let at = 0; at < parts.length; at += 2) {
		const segment = parts[at];
		if (segment.includes(">")) return false;
		const tokens = words(segment).map(unhide);
		const name = tokens[0];
		if (name === undefined) continue;
		commands++;
		if (name.includes("/") || (!READERS.has(name) && name !== "git")) return false;
		const options = tokens.slice(1);
		if (name === "git" && !GIT_READERS.has(options[0] ?? "")) return false;
		if (options.some((option) => WRITING_OPTIONS[name]?.(option))) return false;
		if (name === "uniq" && writesOperand(options)) return false;
	}
	return commands > 0;
}
