import { gitOptionsEnd, type Word } from "./program-forms.ts";
import { base } from "./words.ts";
import { WRAPPERS } from "./wrapper-options.ts";

/**
 * Wrappers that run their command with words read at run time. `xargs` appends words from standard input or an argument
 * file (`-a`), or with `-I`/`-i`/`-J`/`--replace` puts them where a replace string stands; bare `xargs` runs `echo`.
 * `parallel` does the same from input or `:::` lists (`{}` and its variants are replace strings), and with no command
 * runs each input line as one. A word from input may be an operand or an option (`-delete`, `-o f`), so what the command
 * writes cannot be judged from the words the line shows unless its program writes nothing whatever its words.
 */
const INPUT_RUNNERS = new Set(["xargs", "parallel"]);

/** The input runner in front of a command (`runInput`). */
export interface RunInput {
	/** `xargs` or `parallel`. */
	runner: string;
	/**
	 * The program itself comes from input: nothing but wrappers follows the runner (`xargs sudo`, `xargs env`), `parallel`
	 * has no command, or the program word holds a replace string (`xargs -I{} {} a`, `parallel ::: cmd`).
	 */
	programFromInput: boolean;
	/** The replace strings the runner's options set (`-I{}`); input words stand where a word holds one, else they are appended. */
	replaces: string[];
}

/** The replace strings `xargs` options set between `from` and `to`: `-I x`, `-Ix`, `-J x`, `-i` (`{}`), `-ix`, `--replace[=x]`. */
function replaceStrings(literals: ReadonlyArray<Word>, from: number, to: number): string[] {
	const found: string[] = [];
	for (let at = from; at < to; at++) {
		const word = literals[at] ?? "";
		if (word === "--replace") found.push("{}");
		else if (word.startsWith("--replace=")) found.push(word.slice("--replace=".length));
		else if (/^-[^-]/.test(word)) {
			// A short cluster: `I`/`J` take the rest or the next word, `i` the rest or `{}`.
			const letter = /[IJi]/.exec(word.slice(1));
			if (!letter) continue;
			const rest = word.slice(letter.index + 2);
			if (rest !== "") found.push(rest);
			else if (letter[0] === "i") found.push("{}");
			else found.push(literals[++at] ?? "");
		}
	}
	return found.filter(Boolean);
}

/** `parallel`'s argument separators (`:::`, `::::`, `:::+`), which stand where the command is when it has none. */
const PARALLEL_SOURCES = /^:{3,4}\+?$/;
/** `parallel`'s replace strings: `{}`, `{.}`, `{/}`, `{#}`, `{1}`, `{=perl=}`... */
const PARALLEL_REPLACE = /\{[^{}]*\}/;

/**
 * The input runner among the words of a wrapper line from `start` up to its command at `real` (`wrappedCommand`), and
 * whether the program itself comes from input; undefined when no input runner is in front of the command.
 */
export function runInput(literals: ReadonlyArray<Word>, start: number, real: number): RunInput | undefined {
	const end = Math.min(real, literals.length);
	let at = -1;
	for (let index = start; index < end; index++) if (INPUT_RUNNERS.has(base(literals[index] ?? ""))) at = index;
	if (at < 0) return undefined;
	const runner = base(literals[at] ?? "");
	const replaces = replaceStrings(literals, at + 1, end);
	if (real >= literals.length) {
		const wrapped = literals.slice(at + 1, end).some((word) => WRAPPERS.has(base(word ?? "")));
		return { runner, programFromInput: runner === "parallel" || wrapped, replaces };
	}
	const program = literals[real];
	if (program === undefined) return { runner, programFromInput: true, replaces };
	const input: RunInput = { runner, programFromInput: false, replaces };
	input.programFromInput = holdsInput(input, program) || (runner === "parallel" && PARALLEL_SOURCES.test(program));
	return input;
}

/** Whether input words stand in `word`: it holds an `xargs` replace string, or for `parallel` one of `{}`, `{.}`, `{1}`… */
function holdsInput(input: RunInput, word: Word): boolean {
	if (word === undefined) return false;
	return (
		input.replaces.some((replace) => word.includes(replace)) ||
		(input.runner === "parallel" && PARALLEL_REPLACE.test(word))
	);
}

/** `git` subcommands that change only the index and objects of the repository, or read, whatever options follow. */
const GIT_INDEX_ONLY = new Set(["add", "ls-files", "check-ignore"]);

/**
 * Whether `git` with `args` stays within its index whatever words input adds. git reads its own options only up to the
 * subcommand (git.c `handle_options` stops at the first word not starting with `-`), so a word appended after a visible
 * subcommand reaches that subcommand's parser, never `-c`, `-C` or `--exec-path`: what it can do is what the
 * subcommand's options can. `add` (builtin/add.c), `ls-files` and `check-ignore` change the index or read, whatever
 * their options. `rm --cached` keeps the work tree only until a later `--no-cached` (a negatable boolean), so it needs a
 * visible `--` after `--cached` that the input follows. No word up to the subcommand may stand for input (`-I{}`), and
 * for `rm` none up to the `--`. Every other subcommand can write a file (`checkout`, `log --output`, `archive -o`).
 */
export function gitInputIndexOnly(args: ReadonlyArray<Word>, input: RunInput): boolean {
	const sub = gitOptionsEnd(args);
	const name = args[sub];
	if (name === undefined || args.slice(0, sub + 1).some((word) => holdsInput(input, word))) return false;
	if (GIT_INDEX_ONLY.has(name)) return true;
	const end = args.indexOf("--", sub + 1);
	const options = args.slice(sub + 1, end);
	return name === "rm" && end > sub && options.includes("--cached") && !options.some((word) => holdsInput(input, word));
}
