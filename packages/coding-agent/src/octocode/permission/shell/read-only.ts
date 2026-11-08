import { bashSyntax } from "../bash-syntax.ts";
import { programSetting } from "./git-programs.ts";
import { gitInputIndexOnly, runInput, type RunInput } from "./input-runners.ts";
import { awkWords, WORD_WRITERS } from "./program-forms.ts";
import { mask, SEPARATOR, unhide, words, wrappedCommand } from "./words.ts";

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
};
/**
 * A git reader's writing options, by subcommand. Any of them may parse diff's options: `--output` writes a file,
 * `--ext-diff` and `--textconv` run the configured filters. Only `grep` runs a program with `-O<pager>`
 * (`--open-files-in-pager`); diff's `-O` reads an order file. No reader's `-o` writes: it is `ls-files --others` and
 * `grep --only-matching`, and log/diff/show refuse it. The `-o` that writes belongs to `format-patch` and `archive`,
 * which are not readers (destinations.ts `gitDestinations` names their files).
 */
const GIT_WRITING = long("output", "ext-diff", "textconv", "open-files-in-pager");
/** `cat-file --filters` runs the configured `filter.<driver>` programs, as `--textconv` runs `diff.<driver>.textconv` (builtin/cat-file.c:1251-1254). */
const GIT_SUBCOMMAND_WRITING: Record<string, OptionTest> = {
	grep: anyOf(short("O"), GIT_WRITING),
	"cat-file": anyOf(GIT_WRITING, long("filters")),
};
/** The writing-option test of the reader `name`, a git reader's by its subcommand (`options[0]`); none for another program. */
const writingTest = (name: string, options: ReadonlyArray<string | undefined>): OptionTest | undefined =>
	name === "git" ? (GIT_SUBCOMMAND_WRITING[options[0] ?? ""] ?? GIT_WRITING) : WRITING_OPTIONS[name];
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
/**
 * The options of the reader `name` that write a file or run another program (`sort -o`, `rg --pre`), with `uniq`'s
 * output operand as `uniq OUTPUT`; empty for a program this file does not list or a `git` subcommand that is not a reader.
 */
export function readerWritingOptions(name: string, options: string[]): string[] {
	if (name === "git" && !GIT_READERS.has(options[0] ?? "")) return [];
	const test = writingTest(name, options);
	const found = options.filter((option) => test?.(option));
	return name === "uniq" && writesOperand(options) ? [...found, "uniq OUTPUT"] : found;
}

/**
 * Whether words read at run time by an input runner (`xargs`, `parallel`) can make `name` write: a reader with a writing
 * option or output operand, `git` but for a visible subcommand that stays in the index (`gitInputIndexOnly`, given its
 * words `args`), or a writer judged by its words (`WORD_WRITERS`, and any awk, `awkWords`). Not a reader that writes
 * nothing whatever its words (`grep`, `wc`), nor a program the guard does not model, whose writes go unjudged with or
 * without the runner.
 */
export function inputMayWrite(name: string, args: ReadonlyArray<string | undefined>, input: RunInput): boolean {
	if (READERS.has(name)) return WRITING_OPTIONS[name] !== undefined || name === "uniq";
	if (name === "git") return !gitInputIndexOnly(args, input);
	return WORD_WRITERS.has(name) || awkWords(name, args) !== undefined;
}

/**
 * Options whose next word is their value, by reader (git's for any reader subcommand): `find -name "$N"` reads the value
 * as a pattern whatever it holds, so a quoted value there never becomes an option.
 */
const VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
	find: new Set(
		["name", "path", "wholename", "regex", "lname"]
			.flatMap((test) => [`-${test}`, `-i${test}`])
			.concat(["-type", "-newer", "-user", "-group", "-perm", "-size", "-mtime", "-mmin", "-maxdepth", "-mindepth"]),
	),
	rg: new Set(["-e", "--regexp", "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not", "-r", "--replace"]),
	sort: new Set(["-k", "--key", "-t", "--field-separator"]),
	date: new Set(["-d", "--date", "-r", "--reference"]),
	tree: new Set(["-L", "-P", "-I"]),
	git: new Set(["--since", "--until", "--after", "--before", "--author", "--committer", "--grep", "-n"]),
};
const DOUBLE_QUOTED = /^"(?:[^"\\]|\\.)*"$/s;

/** Whether `raw`, a word's source text, has a `$` or backtick outside quotes: the shell splits what it expands into words. */
function splits(raw: string): boolean {
	let quote: string | undefined;
	for (let at = 0; at < raw.length; at++) {
		const char = raw[at];
		if (char === "\\" && quote !== "'") at++;
		else if (quote) {
			if (char === quote) quote = undefined;
		} else if (char === "'" || char === '"') quote = char;
		else if (char === "$" || char === "`") return true;
	}
	return false;
}

/**
 * A substitution that prints a commit id or ref name, so it cannot become an option: `$(git merge-base main HEAD)`, the
 * first step of reviewing a branch, with an optional `..HEAD`. `rev-parse` echoes words it does not know, so its flags
 * are spelled out and its operands may not start with `-`.
 */
const PRINTS_A_REVISION =
	/^"?\$\(git (?:merge-base(?: --[a-z-]+)*(?: [\w@~^/.:-]+)+|rev-parse(?: --(?:short|verify|abbrev-ref))*(?: [A-Za-z0-9_@~^/.:][\w@~^/.:-]*)+)\)(?:\.\.\.?[\w@~^/.-]+)?"?$/;

/**
 * Whether a word the parse cannot spell out (`raw`, its source text; `previous`, the value of the word before it) still
 * cannot become an option of a reader whose writing options `test` names: it is not split (`splits`) and its value starts
 * with a literal character other than `-` (`src/*.ts`, `./"$F"`, `"src/$X"`; a glob there matches only names with that
 * start), or it is a quoted value right after one of the reader's value-taking options (`-name "$N"`), or it is a long
 * option with a literal name and an attached value (`--since="$D"`) that does not write.
 */
function cannotBeOption(
	raw: string,
	previous: string | undefined,
	values: ReadonlySet<string> | undefined,
	test: OptionTest,
): boolean {
	if (PRINTS_A_REVISION.test(raw)) return true;
	if (splits(raw)) return false;
	if (/^(?:""|'')*["']?[A-Za-z0-9_./]/.test(raw)) return true;
	if (previous !== undefined && values?.has(previous) && DOUBLE_QUOTED.test(raw)) return true;
	const named = /^--[A-Za-z0-9][\w-]*=/.exec(raw)?.[0];
	return named !== undefined && !test(named);
}

/**
 * The first word the reader `name` is given before `--` (any word for `find` and `uniq`, whose operands act) that the
 * line does not spell out (undefined in `args`) and that may become a writing option at run time, or `uniq`'s output
 * operand: its source text from `raws` (same indexes as `args`), or "a computed word" without them. Undefined when there
 * is none, or `name` has no writing form. A word that `cannotBeOption` is not one.
 */
export function computedOption(
	name: string,
	args: ReadonlyArray<string | undefined>,
	raws?: ReadonlyArray<string>,
): string | undefined {
	if (name === "git" && !GIT_READERS.has(args[0] ?? "")) return undefined;
	const test = writingTest(name, args);
	if (name !== "uniq" && !test) return undefined;
	const end = name === "find" || name === "uniq" ? -1 : args.indexOf("--");
	for (let at = 0; at < args.length && (end < 0 || at < end); at++) {
		if (args[at] !== undefined) continue;
		const raw = raws?.[at];
		if (raw !== undefined && test && cannotBeOption(raw, args[at - 1], VALUE_OPTIONS[name], test)) continue;
		return raw ?? "a computed word";
	}
	return undefined;
}

/** `git` subcommands that only read the repository. */
export const GIT_READERS: ReadonlySet<string> = new Set([
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
	"merge-base",
	"for-each-ref",
	"cherry",
	"show-branch",
	"name-rev",
	"check-ignore",
	"range-diff",
]);
/** Redirections that write nowhere: to a file descriptor (`2>&1`), or to exactly `/dev/null` (not `/dev/nullx`, not `/dev/null/../x`). */
const HARMLESS_REDIRECT = /(?:&|\d*)>>?\s*(?:&\d+|\/dev\/null)(?=\s|$)/g;

/**
 * Whether one simple command, as its words (program first, wrappers already skipped; undefined for a word the parse
 * cannot spell out; `raws`, their source text when known), only reads: a program of `READERS` or a read-only `git`
 * subcommand, without an option that writes a file or runs another program, and `uniq` without an output operand. An
 * unresolved word (`$X`, a glob) may expand to such an option, so a reader that has one takes it only when it cannot
 * become one (`computedOption`). Behind an input runner (`input`), whose words from input may be any option, only a
 * reader with no writing form reads.
 */
function reads(tokens: ReadonlyArray<string | undefined>, input?: RunInput, raws?: ReadonlyArray<string>): boolean {
	const [name, ...options] = tokens;
	if (name === undefined || name.includes("/")) return false;
	if (input && (input.programFromInput || inputMayWrite(name, options, input))) return false;
	if (!READERS.has(name) && name !== "git") return false;
	if (name === "git" && !GIT_READERS.has(options[0] ?? "")) return false;
	if (computedOption(name, options, raws?.slice(1)) !== undefined) return false;
	const test = writingTest(name, options);
	const known = options.filter((option): option is string => option !== undefined);
	if (known.some((option) => test?.(option))) return false;
	return name !== "uniq" || !writesOperand(known);
}

/** The quick lexical reading: the command split at its operators (`mask`), each part's words past wrappers (`words`). */
function maskedReadOnly(command: string): boolean {
	const bodies: string[] = [];
	const parts = mask(command, bodies).replace(HARMLESS_REDIRECT, " ").split(SEPARATOR);
	let commands = 0;
	for (let at = 0; at < parts.length; at += 2) {
		const segment = parts[at];
		if (segment.includes(">")) return false;
		const tokens = words(segment, true).map(unhide);
		// `words` drops the wrappers in front: an input runner among them (`xargs sudo`) may run what its input names.
		const all = segment.trim().split(/\s+/).filter(Boolean).map(unhide);
		// A variable set in front or alone (`GIT_PAGER=x git log`, `GIT_PAGER=x; git log`) through which git runs a program.
		if (all.slice(0, all.length - tokens.length).some((word) => programSetting(word) !== undefined)) return false;
		const input = runInput(all, 0, all.length - tokens.length);
		if (tokens.length === 0) {
			if (input?.programFromInput) return false;
			continue;
		}
		commands++;
		if (!reads(tokens, input)) return false;
	}
	return commands > 0;
}

/** One word of a plain command: literal characters and quoted text with no expansion (`$`, backtick, `\`, `!`) in it. */
const PLAIN_WORD = String.raw`(?:[\w@%+=:,./~-]|'[^']*'|"[^"$\`\\!]*")+`;
const PLAIN_COMMAND = new RegExp(`^[ \\t]*${PLAIN_WORD}(?:[ \\t]+${PLAIN_WORD})*[ \\t]*$`);
/** `sed -n 'A,Bp'`: the one `sed` form that prints lines and cannot write (`w`), run (`e`) or edit in place (`-i`). */
const SED_PRINT = /^\d+(?:,(?:\d+|\$))?p$/;

/**
 * Whether `command` is one plain simple command that only reads, judged by its text alone: words with no operator,
 * redirection, expansion, glob or line break (`PLAIN_WORD`), a program of `READERS` or a read-only `git` subcommand without a
 * writing option (`reads`), or `sed -n 'A,Bp'` (`SED_PRINT`). For a line the bash parse could not read (it has a time
 * budget and may be unloaded): the text is simple enough that no second reading is needed, and anything else is false.
 */
export function plainReader(command: string): boolean {
	if (!PLAIN_COMMAND.test(command)) return false;
	const tokens = (command.match(new RegExp(PLAIN_WORD, "g")) ?? []).map((word) =>
		word.replace(/'([^']*)'|"([^"]*)"/g, (_all, single?: string, double?: string) => single ?? double ?? ""),
	);
	const [name, ...rest] = tokens;
	if (name === undefined || !/^[A-Za-z][\w.-]*$/.test(name)) return false;
	if (name === "sed")
		return rest[0] === "-n" && SED_PRINT.test(rest[1] ?? "") && rest.slice(2).every((word) => !word.startsWith("-"));
	return reads(tokens);
}

/**
 * The bash parse's reading: complete (no syntax it does not model), no write target, and every simple command it finds
 * (in a list, pipeline or substitution, past wrappers) a reader by `reads`.
 */
function parsedReadOnly(command: string): boolean {
	const syntax = bashSyntax(command);
	if (syntax.incomplete || syntax.targets.some((target) => target.kind === "write")) return false;
	return syntax.commands.every((part) => {
		const literals = part.tokens.map((token) => token.literal);
		const at = wrappedCommand(literals, 0);
		if (at === undefined) return false;
		const input = runInput(literals, 0, at);
		const raws = part.tokens.slice(at).map((token) => token.raw);
		return at >= literals.length ? !input?.programFromInput : reads(literals.slice(at), input, raws);
	});
}

/**
 * PowerShell syntax a bash reading gets wrong: the backtick escape, `<#…#>` block comments, `@'…'@` here-strings and
 * `--%` (the rest of the line passed as is). A PowerShell line with any of them is not taken as read-only.
 */
const POWERSHELL_ONLY = /`|<#|#>|@['"]|--%/;

/**
 * Whether every command `command` runs only reads: each simple command (in a pipeline, after `&&` or `;`, in a
 * substitution, or behind a wrapper such as `sudo` or `xargs`) is a program of `READERS` or a read-only `git`
 * subcommand, without an option that writes a file or runs another program (`WRITING_OPTIONS`, abbreviations
 * included), and nothing is redirected but to a file descriptor or `/dev/null`. A command the list does not know is
 * not read-only, and neither is a shell given a script (`sh -c`) or `uniq` given an output operand.
 *
 * Gates rely on it (plan mode, the reservation gate, `shellMutation`'s shortcut, PowerShell callers), so the quick
 * lexical reading alone never decides: the bash parse (`bashSyntax`) must agree, and a line it cannot read fully, or
 * read without the parser loaded, is not read-only. A mistake in either reading then costs a check, not a bypass.
 * `shell: "powershell"` also refuses syntax only PowerShell has (`POWERSHELL_ONLY`).
 */
export function readOnlyCommand(command: string, shell: "bash" | "powershell" = "bash"): boolean {
	if (shell === "powershell" && POWERSHELL_ONLY.test(command)) return false;
	return maskedReadOnly(command) && parsedReadOnly(command);
}
