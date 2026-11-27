import type { ParsedCommand, ParsedShell } from "../shared/shell-commands.ts";

/**
 * The commands the reservation gate lets run while another agent holds a path, even when an argument is a variable or a
 * glob the line does not spell out: readers with no write form of their own. The gate otherwise refuses such a command,
 * since a computed word may become an option that writes; for these the owner accepted that, because they were the
 * largest single cause of refused read-only work (RFC 2026-11-11 core tools, step B4).
 */
const READERS = new Set(["rg", "grep", "ls", "cat", "wc", "fd"]);
const GIT_READERS = new Set(["log", "diff", "show", "ls-files", "status", "rev-parse", "ls-tree"]);

/**
 * Filters and shell builtins that print and write nothing, which let a pipeline or a `cd dir &&` prefix run. A computed
 * word before one of the readers above is accepted (`rg x $dir`); here it is not (`sort $X in`), because the parse marks
 * such a command `opaque` when a word it does not spell out may become `-o` or an output operand (`computedOption`).
 * Their own writing forms (`sort -o`, `uniq IN OUT`, `printf -v`, `tail -f`, which never ends) are refused by `FILTER_WRITES`.
 */
const FILTERS = new Set([
	"head",
	"tail",
	"cut",
	"tr",
	"uniq",
	"sort",
	"nl",
	"column",
	"jq",
	"basename",
	"dirname",
	"echo",
	"printf",
	"true",
	"cd",
	"pwd",
]);

/** A long option by any prefix of one of `names` (`--out` is `--output` to getopt). */
const longOption =
	(...names: string[]) =>
	(option: string): boolean => {
		if (!option.startsWith("--")) return false;
		const flag = option.slice(2).split("=")[0] ?? "";
		return flag !== "" && names.some((name) => name.startsWith(flag));
	};
/** A short option letter anywhere in a cluster (`-ro`) or with its value attached (`-ofile`). */
const shortOption =
	(letters: string) =>
	(option: string): boolean =>
		new RegExp(`^-[A-Za-z0-9]*[${letters}]`).test(option);

const sortWrites = (option: string) => shortOption("o")(option) || longOption("output", "compress-program")(option);
const tailRuns = (option: string) => shortOption("fF")(option) || longOption("follow")(option);

/** `uniq [OPTION]... [INPUT [OUTPUT]]`: a second operand is a file it writes. Options with a separate value are not operands. */
function uniqWritesOperand(args: string[]): boolean {
	let operands = 0;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "--") return operands + (args.length - index - 1) > 1;
		if (/^-[A-Za-z0-9]+$/.test(arg)) {
			// `-f N`, `-s N`, `-w N`, alone or last in a cluster (`-cf N`): the value is the next word.
			const valued = /[fsw]/.exec(arg);
			if (valued && valued.index === arg.length - 1) index++;
		} else if (arg.startsWith("--") && arg !== "--") {
			if (!arg.includes("=") && longOption("skip-fields", "skip-chars", "check-chars")(arg)) index++;
		} else operands++;
	}
	return operands > 1;
}

/**
 * Per program: whether the arguments of the line make it write a file or run something. `options` are the words before
 * `--`, each in its source text and its unquoted value (`--output="$X"` has no value, `"--output=x"` no `--` in its
 * source); `args` are all values after the program, `undefined` where a word is computed.
 */
const FILTER_WRITES: Record<string, (options: string[], args: ReadonlyArray<string | undefined>) => boolean> = {
	sort: (options) => options.some(sortWrites),
	tail: (options) => options.some(tailRuns),
	uniq: (_options, args) => uniqWritesOperand(args.map((arg) => arg ?? "")),
	// `printf -v NAME` assigns a variable (`PATH`, or `a[$(cmd)]`, which bash evaluates): the first word is the format, never an option.
	printf: (_options, args) => args[0] === undefined || (args[0].startsWith("-") && args[0] !== "--"),
};

/** Options, spelled out on the line, that make one of these readers write a file or run a program. */
const WRITES_OR_RUNS: Record<string, RegExp> = {
	rg: /^--(?:pre|hostname-bin)(?:=|$)/,
	fd: /^(?:-[A-Za-z]*[xX]|--exec(?:-batch)?(?:=|$))/,
	git: /^--(?:output|ext-diff)(?:=|$)/,
};

/** A redirection that writes no file: a duplicated descriptor (`2>&1`) or output sent to `/dev/null`. */
const HARMLESS_REDIRECT = /^(?:\d*>&\d+|(?:\d*|&)>>?\s*\/dev\/null)$/;

/** The words between the program and `--`, each as source text and as value: what an option test reads. */
function optionWords(command: ParsedCommand): string[] {
	const end = command.literals.indexOf("--");
	const count = end === -1 ? command.words.length : end;
	const found: string[] = [];
	for (let index = 1; index < count; index++) {
		found.push(command.words[index] ?? "");
		const literal = command.literals[index];
		if (literal !== undefined) found.push(literal);
	}
	return found;
}

function allowedReader(command: ParsedCommand): boolean {
	// The program is the first word: no assignment before it (`GIT_EXTERNAL_DIFF=x git diff`) and no wrapper.
	if (command.program !== 0) return false;
	const name = command.literals[0];
	if (name === undefined) return false;
	if (!command.redirects.every((redirect) => HARMLESS_REDIRECT.test(redirect.trim()))) return false;
	if (FILTERS.has(name)) {
		if (command.opaque) return false;
		return !FILTER_WRITES[name]?.(optionWords(command), command.literals.slice(1));
	}
	if (name === "git") {
		// The subcommand follows `git` at once: a global option (`-c core.pager=…`, `--exec-path`) could run a program.
		const sub = command.literals[1];
		if (sub === undefined || !GIT_READERS.has(sub)) return false;
	} else if (!READERS.has(name)) return false;
	const risky = WRITES_OR_RUNS[name];
	if (!risky) return true;
	// Only up to `--`: what follows it is an operand, whatever it looks like. Both spellings are read, the source text
	// (`--output="$X"` has no literal value) and the value after quotes are removed (`"--output=x"`).
	return !optionWords(command).some((word) => risky.test(word));
}

/**
 * Whether every command of the line is one of the allowed readers, with nothing that defines a function or redirects to
 * a file. A `$(…)`, backtick or process substitution is allowed because the parse lists the commands inside it with the
 * others (`ParsedShell`), so `$(sed -i …)` fails on its `sed`. An unparsed line is never allowed.
 */
export function onlyAllowedReaders(parsed: ParsedShell | undefined): boolean {
	if (!parsed || parsed.commands.length === 0 || parsed.functions.length > 0) return false;
	return parsed.commands.every(checked);
}

/**
 * The synthetic hidden-arithmetic command is no program and names no path: the permission policy keeps it opaque, but
 * the reservation gate has nothing to check in it (accepted risk, see the top of this file).
 */
const checked = (command: ParsedCommand): boolean => command.hiddenArithmetic === true || allowedReader(command);

/**
 * The first stage that keeps a line from `onlyAllowedReaders`, as the refusal names it; undefined when no single stage does.
 * Only a line with hidden arithmetic needs it (the arithmetic would otherwise be blamed); any other line keeps the cause the
 * caller already has, such as an exported variable, which no single stage shows.
 */
export function refusedStage(parsed: ParsedShell | undefined): { name: string; cause: string } | undefined {
	if (!parsed?.commands.some((command) => command.hiddenArithmetic === true)) return undefined;
	const stage = parsed?.commands.find((command) => !checked(command));
	if (!stage) return undefined;
	const text = stage.words.join(" ");
	return {
		name: stage.literals[stage.program ?? 0] ?? text.split(" ")[0] ?? "",
		cause: stage.opaqueBecause ?? `\`${text}\` is not a read-only command the gate can check`,
	};
}
