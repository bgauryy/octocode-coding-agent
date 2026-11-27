/**
 * Whether a bash command runs an interpreter on inline code (`python3 -c`, `node -e`, `perl -i`, a heredoc fed to
 * `python -`). The code decides which files it writes, and no parse of the command line can name them, so the
 * reservation gate treats such a command as it treats PowerShell. Returns the interpreter's name, or undefined.
 * This file may not import the permission layer (`architecture.test.ts`), so the shell parse reaches it as data: the
 * simple commands the bash parser found, wherever they run (`ParsedShell`, from `registerCollab`'s `shellCommands` port).
 * Without one (no port wired) it falls back to a small tokenizer that splits the line on `;&|()` and reads quoted text
 * as one word, which misses groups, function bodies, code piped to stdin and lines with a stray apostrophe. When a port
 * exists but the parse failed (`null`), any command that names an interpreter or shell is refused (`UNPARSED`).
 */
import type { ParsedCommand, ParsedShell } from "../shared/shell-commands.ts";
import { CONFINED_WRAPPERS, confinementFault, NODE, QUOTED, QUOTES, type Run } from "./interpreter-confinement.ts";

/** Programs that run the rest of the line as another command (`sudo python3 -c …`). */
const WRAPPERS = new Set([
	"sudo",
	"doas",
	"env",
	"time",
	"nohup",
	"exec",
	"command",
	"nice",
	"xargs",
	"timeout",
	"stdbuf",
]);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const PYTHON = /^python[\d.]*$/;

/**
 * Whether one option token of the interpreter carries inline code (or edits files in place), with the code apart or glued
 * on (`-c'x'`, `-e=x`, `--eval=x`). Python's code option may follow a cluster of its flags that take no argument.
 */
function inlineOption(name: string, option: string): boolean {
	if (PYTHON.test(name)) return option === "-" || /^-[bBdEhiIOPqsSuvVx]*c/.test(option);
	if (NODE.test(name))
		return (
			option === "-" || /^--(?:eval|print)(?:=|$)/.test(option) || /^-(?:[a-z]*[ep](?:$|[=\u0001])|[ep])/.test(option)
		);
	// A cluster of perl switches ending in the one that takes code (`-pe`, `-lne`), or `-i` with or without a suffix.
	if (name === "perl") return /^-[lnpaswWtTuUxS0-9]*[Eei]/.test(option);
	if (name === "ruby") return /^-[nplaswWdvyZ0-9]*[ei]/.test(option);
	return false;
}

function interpreterName(token: string): string | undefined {
	const name = token.slice(token.lastIndexOf("/") + 1).replace(/\.exe$/i, "");
	return PYTHON.test(name) || NODE.test(name) || name === "perl" || name === "ruby" || name === "deno"
		? name
		: undefined;
}

const baseName = (token: string): string => token.slice(token.lastIndexOf("/") + 1);

/** Options that take the next word as their value, so it is not the script (`python3 -W ignore`, `node -r pre.js`). */
const VALUE_OPTIONS = new Set([
	"-W",
	"-X",
	"-r",
	"--require",
	"--import",
	"--loader",
	"--experimental-loader",
	"--check-hash-based-pycs",
	"-I",
	"-C",
]);
const INFO_OPTION = /^(?:-V+|-v|--version|-h|--help)$/;

/** Whether the words after an interpreter name a script or module, or ask for information, so standard input is data. */
function readsFile(words: string[]): boolean {
	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		if (word === "-m" || INFO_OPTION.test(word) || !word.startsWith("-")) return true;
		if (VALUE_OPTIONS.has(word)) index++;
	}
	return false;
}

/**
 * The run in one command's words, or undefined. Inline code is an option that carries it, a heredoc, `<(…)`, or code on
 * standard input: a bare interpreter behind a pipe or an input redirect that names no script.
 */
function runOf(tokens: string[], redirects: string[], stdin: ParsedCommand["stdin"]): Run | undefined {
	let at = 0;
	while (at < tokens.length && ASSIGNMENT.test(tokens[at])) at++;
	// After a wrapper, any later word may be the program (`sudo -u root python -c …`).
	const wrapped = at < tokens.length && WRAPPERS.has(baseName(tokens[at]));
	for (let index = at; index < (wrapped ? tokens.length : at + 1); index++) {
		const name = interpreterName(tokens[index] ?? "");
		if (!name) continue;
		const words = tokens.slice(index + 1);
		const rest = [...words, ...redirects];
		const inline =
			name === "deno"
				? words[0] === "eval" || (words[0] === "run" && words[1] === "-")
				: rest.some((option) => inlineOption(name, option));
		const fed = stdin === "heredoc" || ((stdin === "pipe" || stdin === "file") && !readsFile(words));
		if (inline || fed || rest.some((word) => word.startsWith("<<") || word.startsWith("<(")))
			return { name, program: tokens[index], before: tokens.slice(0, index), rest };
		return undefined;
	}
	return undefined;
}

/** Programs the shell may run in place of an interpreter or its wrapper: a function or alias by that name takes over. */
const redefinable = (name: string): boolean =>
	interpreterName(name) !== undefined || WRAPPERS.has(name) || CONFINED_WRAPPERS.has(name);
/** Programs that run code the parse reads only in part. */
const CODE_RUNNERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "eval", "trap", "source", "."]);

const opaqueRun = (name: string, program = name, because?: string): Run => ({
	name,
	program,
	before: [],
	rest: [],
	opaque: true,
	...(because ? { because } : {}),
});

/** Whether a program word with a glob (`pyth*3`, `/usr/bin/nod?`) could expand to an interpreter. */
function globNamesInterpreter(word: string): boolean {
	const name = baseName(word);
	if (/[$`]/.test(word) || name === "[" || !/[*?[]/.test(name)) return false;
	try {
		const glob = new RegExp(
			`^${name
				.replace(/[.+^${}()|\\]/g, "\\$&")
				.replace(/\*/g, ".*")
				.replace(/\?/g, ".")}$`,
		);
		return ["python", "python3", "node", "nodejs", "perl", "ruby", "deno"].some((candidate) => glob.test(candidate));
	} catch {
		return false;
	}
}

/** Python modules that read code from standard input or from their arguments. */
const CODE_MODULES = new Set(["code", "pdb", "timeit", "cProfile", "profile", "trace", "runpy"]);
const STDIN_FILE = /^\/dev\/(?:stdin|fd\/\d+)$/;

/**
 * Reads an interpreter's words up to its script operand: only options before it (or before `-m module`, which takes the
 * rest) can carry inline code. `inline`: code in an option, `-`, `/dev/stdin` or a code module; `script`: a script or
 * module is named, so standard input is data.
 */
function scanOptions(name: string, args: Array<string | undefined>): { inline: boolean; script: boolean } {
	const deno = name === "deno";
	if (deno && (args[0] === "eval" || args[0] === "repl")) return { inline: args[0] === "eval", script: false };
	for (let index = deno && args[0] === "run" ? 1 : 0; index < args.length; index++) {
		const word = args[index];
		// A word with no static value (`--allow-fs-read=*`, `$X`) may be an option: keep reading.
		if (word === undefined) continue;
		if (INFO_OPTION.test(word)) return { inline: false, script: true };
		if (word === "-" || STDIN_FILE.test(word)) return { inline: true, script: false };
		if (word === "--") return { inline: STDIN_FILE.test(args[index + 1] ?? ""), script: index + 1 < args.length };
		if (PYTHON.test(name) && word === "-m") {
			const module = args[index + 1] ?? "";
			return { inline: module === "timeit", script: !CODE_MODULES.has(module) };
		}
		if (!word.startsWith("-")) return { inline: false, script: true };
		if (!deno && inlineOption(name, word)) return { inline: true, script: false };
		if (VALUE_OPTIONS.has(word)) index++;
	}
	return { inline: false, script: false };
}

/**
 * The run in one parsed command: the program and its options are read from the shell's values (`literals`), so quotes
 * and escapes do not hide them, while `before` and `rest` stay raw text for `confinementFault`, where a quoted word is never an option.
 */
function parsedRun(command: ParsedCommand, tokens: string[], redirects: string[]): Run | undefined {
	const at = command.program;
	if (at === undefined) return undefined;
	const literal = command.literals[at];
	// A glob that can match an interpreter (`pyth*3 -c x`) counts as one; a variable (`$PY`) is not guessed at.
	if (literal === undefined && globNamesInterpreter(command.words[at]))
		return opaqueRun(baseName(command.words[at]), tokens[at]);
	const name = interpreterName(literal ?? "");
	if (!name) return undefined;
	const rest = [...tokens.slice(at + 1), ...redirects];
	const { inline, script } = scanOptions(name, command.literals.slice(at + 1));
	const stdin = command.stdin;
	const fed = stdin === "heredoc" || ((stdin === "pipe" || stdin === "file") && !script && !inline);
	if (!inline && !fed && !rest.some((word) => word.startsWith("<<") || word.startsWith("<("))) return undefined;
	return { name, program: tokens[at], before: tokens.slice(0, at), rest };
}

/** Every inline-code run in the parsed commands, and each function or alias that redefines an interpreter or wrapper. */
function parsedRuns(parsed: ParsedShell): Run[] {
	const runs: Run[] = parsed.functions.filter(redefinable).map((name) => opaqueRun(name));
	for (const command of parsed.commands) {
		const tokens = command.words.map((word) => word.replace(QUOTES, QUOTED));
		const start = tokens.findIndex((token) => !ASSIGNMENT.test(token));
		if (start < 0) continue;
		const redirects = command.redirects.map((word) => word.replace(QUOTES, QUOTED));
		const run = parsedRun(command, tokens, redirects);
		if (run) runs.push(run);
		// The runner is the program or a word before it; past a known program the words are its operands (`rg x .`).
		const end = command.program === undefined ? command.literals.length : command.program + 1;
		const runner = command.literals
			.slice(start, end)
			.find((word) => word !== undefined && CODE_RUNNERS.has(baseName(word)));
		// Opaque code with no shell or runner named is a wrapper's hidden command (`env -S "$X"`, `timeout $T …`), named by
		// the wrapper, or a computed program (`$PY -c …`, `$(…) a b`), named by its source text.
		const wrapper = command.literals[start] ?? command.words[start] ?? "env";
		if (command.opaque) runs.push(opaqueRun(baseName(runner ?? wrapper), runner ?? wrapper, command.opaqueBecause));
		if (baseName(command.literals[start] ?? "") === "alias") {
			const defined = command.literals.slice(start + 1).map((word) => (word ?? "").split("=")[0]);
			const name = defined.find(redefinable);
			if (name) runs.push(opaqueRun(name));
		}
	}
	return runs;
}

/** Every inline-code run in a command line: from the parse when there is one, else from the tokenizer. */
function inlineRuns(command: string, parsed?: ParsedShell): Run[] {
	if (parsed) return parsedRuns(parsed);
	const runs: Run[] = [];
	// A backslash before a newline joins the lines, so `python3 \⏎ -c …` is one command.
	const bare = command.replace(/\\\r?\n/g, " ").replace(QUOTES, QUOTED);
	for (const segment of bare.split(/[;&|\n()`]+/)) {
		const run = runOf(segment.trim().split(/\s+/).filter(Boolean), [], undefined);
		if (run) runs.push(run);
	}
	return runs;
}

/** `parsed` is the shell parse of `command` (see the file comment); without it the tokenizer reads the line. */
export function inlineInterpreter(command: string, parsed?: ParsedShell): string | undefined {
	return inlineRuns(command, parsed)[0]?.name;
}

/** An interpreter, shell or code runner named anywhere in the text (quoted or not): what a failed parse can still tell. */
const UNPARSED = /(?<![\w.-])(python[\d.]*|node(?:js)?|perl|ruby|deno|bash|sh|zsh|dash|ksh|eval)(?:\.exe)?(?![\w.-])/;

/** The interpreter a command runs on code nothing bounds, and `cause`: the part of the line that keeps it from the confined form (`confinementFault`). */
export interface InterpreterRefusal {
	name: string;
	cause: string;
	/** False when the parse named a reason that is not inline code (`Run.because`: a reader given a computed word, arithmetic, a program git runs). */
	interpreter: boolean;
}

/**
 * The first inline interpreter in a command whose writes nothing bounds (`inlineInterpreter` less the runs
 * `confinementFault` proves read-only), with why it is not confined; undefined when none. `env` defaults to this process's,
 * which the bash tool passes on. `parsed` is the shell parse of `command`; `null` says a parser exists but could not read
 * the line (unavailable, a syntax error, too large or too slow), so the tokenizer's answer stands and otherwise any
 * interpreter or shell named in the text is refused, because nothing proves the line runs no inline code. `undefined`
 * means no parser is wired: the tokenizer decides.
 */
export function interpreterRefusal(
	command: string,
	env: NodeJS.ProcessEnv = process.env,
	parsed?: ParsedShell | null,
): InterpreterRefusal | undefined {
	return interpreterRefusals(command, env, parsed)[0];
}

/** Every refusal `interpreterRefusal` could name, in line order, then the failed parse's (`node-confine.ts` needs them all). */
export function interpreterRefusals(
	command: string,
	env: NodeJS.ProcessEnv,
	parsed?: ParsedShell | null,
): InterpreterRefusal[] {
	const refusals: InterpreterRefusal[] = [];
	for (const run of inlineRuns(command, parsed ?? undefined)) {
		const cause = confinementFault(run, command, env);
		if (cause !== undefined) refusals.push({ name: run.name, cause, interpreter: run.because === undefined });
	}
	const named = parsed === null ? UNPARSED.exec(command)?.[1] : undefined;
	if (named !== undefined)
		refusals.push({ name: named, cause: "the line could not be parsed, so it may run inline code", interpreter: true });
	return refusals;
}
