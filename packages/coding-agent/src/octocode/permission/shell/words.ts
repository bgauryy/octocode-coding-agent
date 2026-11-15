import { BODY, unhide } from "../../../../../common/src/shell-words.ts";
export { ansiC, BODY, hide, mask, SEPARATOR, unhide } from "../../../../../common/src/shell-words.ts";
import { LEADING_OPERANDS, optionWidth, WRAPPERS } from "./wrapper-options.ts";

export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Programs whose operands are the paths they remove. */
export const REMOVERS = new Set(["rm", "rmdir", "unlink", "shred"]);

export const base = (token: string): string => token.slice(token.lastIndexOf("/") + 1);

/**
 * A simple command's words, past wrappers (their options, option values and leading operands) and `VAR=value`. With
 * `strict`, a wrapper option `wrapper-options.ts` does not know stops the walk there, so the first word is that option
 * rather than a guess at the command (for checks that must not mistake a writer for a reader).
 */
export function words(segment: string, strict = false): string[] {
	const tokens = segment.trim().split(/\s+/).filter(Boolean);
	let wrapper: string | undefined;
	let operands = 0;
	while (tokens.length > 0) {
		const token = tokens[0];
		if (WRAPPERS.has(base(token))) {
			wrapper = base(token);
			operands = LEADING_OPERANDS[wrapper] ?? 0;
			tokens.shift();
		} else if (/^\w+=/.test(token)) {
			tokens.shift();
		} else if (token.startsWith("-") && tokens.length > 1) {
			const width = wrapper ? optionWidth(wrapper, token) : 1;
			if (width === undefined && strict) break;
			tokens.splice(0, width ?? 1);
		} else if (operands > 0 && tokens.length > 1) {
			operands--;
			tokens.shift();
		} else break;
	}
	return tokens;
}

/** What `env -S`/`--split-string` was given: the string env splits into a command and arguments (undefined when unresolved), and the index after it. */
export interface EnvSplit {
	value: string | undefined;
	end: number;
}

/** `env`'s split-string option at `at`: `-S x`, `-Sx`, a cluster ending in it (`-iS x`), `--split-string x`, `--split-string=x` or a prefix of that name. */
function envSplit(literals: ReadonlyArray<string | undefined>, at: number): EnvSplit | undefined {
	const token = literals[at] ?? "";
	if (token.startsWith("--")) {
		const name = token.split("=")[0];
		if (name.length < 4 || !"--split-string".startsWith(name)) return undefined;
		return token.includes("=")
			? { value: token.slice(name.length + 1), end: at + 1 }
			: { value: literals[at + 1], end: at + 2 };
	}
	const cluster = /^-[^uC-]*S/.exec(token)?.[0];
	if (cluster === undefined) return undefined;
	return token.length > cluster.length
		? { value: token.slice(cluster.length), end: at + 1 }
		: { value: literals[at + 1], end: at + 2 };
}

/**
 * The index of the command a wrapper line really runs, given the literal words and the index of the first one: past
 * wrappers (`sudo -u root`, `env -i A=1`, `exec -a name`, `nohup`, `time`), their options, option values and leading operands.
 * Undefined when an unresolved word (`$CMD`) stands where the command should be, or when `env -S` splits a string into the
 * command (`splitString` reads that); `literals.length` when nothing follows.
 */
export function wrappedCommand(literals: ReadonlyArray<string | undefined>, start: number): number | undefined {
	return scanWrapped(literals, start).at;
}

/** The `env -S` string a wrapper line runs as its command, when `wrappedCommand` stopped there. */
export function splitString(literals: ReadonlyArray<string | undefined>, start: number): EnvSplit | undefined {
	return scanWrapped(literals, start).split;
}

function scanWrapped(
	literals: ReadonlyArray<string | undefined>,
	start: number,
): { at: number | undefined; split?: EnvSplit } {
	let at = start;
	let wrapper: string | undefined;
	let operands = 0;
	while (at < literals.length) {
		const token = literals[at];
		if (token === undefined) return { at: wrapper === undefined ? at : undefined };
		const split = wrapper === "env" && token.startsWith("-") ? envSplit(literals, at) : undefined;
		if (split) return { at: undefined, split };
		if (WRAPPERS.has(base(token))) {
			wrapper = base(token);
			operands = LEADING_OPERANDS[wrapper] ?? 0;
			// `command -v rm` only looks a command up.
			if (wrapper === "command" && ["-v", "-V"].includes(literals[at + 1] ?? "")) return { at };
			at++;
		} else if (wrapper === undefined) break;
		else if (/^\w+=/.test(token)) at++;
		else if (token.startsWith("-") && at + 1 < literals.length) {
			// An option the table does not know may take the next word as its value: the command is not known.
			const width = optionWidth(wrapper, token);
			if (width === undefined) return { at: undefined };
			at += width;
		} else if (operands > 0 && at + 1 < literals.length) {
			operands--;
			at++;
		} else break;
	}
	// A wrapped "command" with spaces in it is a script string (`watch 'cp a b'`), not a program name.
	if (wrapper !== undefined && /\s/.test(literals[at] ?? "")) return { at: undefined };
	return { at };
}

/** For a shell command: the script it runs from `-c`, or whether it reads its script from standard input. */
export function shellScript(tokens: string[]): { script?: string; stdin: boolean } {
	for (let at = 1; at < tokens.length; at++) {
		const token = tokens[at];
		if (token === "--") return { stdin: at + 1 >= tokens.length };
		if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(token)) return { script: tokens[at + 1] ?? "", stdin: false };
		if (/^-[a-zA-Z]*s/.test(token)) return { stdin: true };
		// Option values and redirection targets (`-o pipefail`, `> log`, `<<< text`) are not a script file.
		if (/^[-+][oO]$/.test(token) || /^\d*(?:<<<|<|>>?|&>)$/.test(token)) at++;
		else if (!/^[-+]/.test(token) && !BODY.test(token) && !/^\d*[<>&]/.test(token)) return { stdin: false };
	}
	return { stdin: true };
}

/**
 * The scripts one simple command runs in a nested shell: `eval`'s arguments, and a shell's `-c` script or, when it reads
 * standard input, its heredoc, herestring and `fromPipe` (what the previous command in a pipe emitted).
 */
export function nestedScripts(name: string, tokens: string[], bodies: string[], fromPipe: string[]): string[] {
	const scripts: string[] = [];
	if (name === "eval") scripts.push(tokens.slice(1).map(unhide).join(" "));
	if (SHELLS.has(name)) {
		const shell = shellScript(tokens);
		if (shell.script !== undefined) scripts.push(unhide(shell.script));
		if (shell.stdin) scripts.push(...stdinOf(tokens, bodies).map(unhide), ...fromPipe);
	}
	return scripts;
}

/** What one simple command (its words, masked) feeds a pipe into a shell: `echo`/`printf` arguments, or `cat`'s heredoc or herestring. */
export function fedToPipe(tokens: string[], bodies: string[]): string[] {
	const name = base(unhide(tokens[0] ?? ""));
	if (name === "echo" || name === "printf") return [unhide(tokens.slice(1).join(" "))];
	return name === "cat" ? stdinOf(tokens, bodies).map(unhide) : [];
}

/** Text a command feeds to the next one's standard input: `echo`/`printf` arguments, or its own heredoc or herestring. */
export function stdinOf(tokens: string[], bodies: string[]): string[] {
	const fed: string[] = [];
	tokens.forEach((token, at) => {
		const body = BODY.exec(token);
		if (body) fed.push(bodies[Number(body[1])] ?? "");
		else if (token === "<<<") fed.push(tokens[at + 1] ?? "");
		else if (token.startsWith("<<<")) fed.push(token.slice(3));
	});
	return fed;
}
