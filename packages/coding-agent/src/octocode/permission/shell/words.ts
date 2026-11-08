import { LEADING_OPERANDS, optionWidth, WRAPPERS } from "./wrapper-options.ts";

export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Programs whose operands are the paths they remove. */
export const REMOVERS = new Set(["rm", "rmdir", "unlink", "shred"]);

/**
 * Whitespace and shell operators inside quotes are shifted into this private-use block, so a quoted string stays one
 * word and splits nothing; `unhide` shifts them back, so a quoted script (`bash -c "…"`) can be checked as a command.
 */
const HIDDEN_BASE = 0xe000;
const OPERATOR = /[\s;&|()`<>$]/g;
const HIDDEN = /[\ue000-\ue07f]/g;
/** Stands for a heredoc in the masked command: `\u0002<index>` into the collected bodies. */
export const BODY = /^\u0002(\d+)$/;
const HEREDOC = /^<<(-?)[ \t]*(['"]?)([\w.-]+)\2/;
/** Separators between simple commands; captured so a pipe into a shell can be recognised. */
export const SEPARATOR = /(\|\||&&|[;&|\n()`]|\$\()/;

export const hide = (text: string): string =>
	text.replace(OPERATOR, (char) => String.fromCharCode(HIDDEN_BASE + char.charCodeAt(0)));
export const unhide = (text: string): string =>
	text.replace(HIDDEN, (char) => String.fromCharCode(char.charCodeAt(0) - HIDDEN_BASE));
export const base = (token: string): string => token.slice(token.lastIndexOf("/") + 1);

/** Single-character escapes of bash's ANSI-C quoting (`$'…'`). */
const ANSI_C: Record<string, string> = {
	a: "\x07",
	b: "\b",
	e: "\x1b",
	E: "\x1b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"\\": "\\",
	"'": "'",
	'"': '"',
	"?": "?",
};

/**
 * The text bash makes of an ANSI-C quoted body (between `$'` and `'`): its letter, octal (`\101`) and hex (`\x41`)
 * escapes decoded, an unknown escape kept with its backslash, cut at a NUL as bash cuts it. Undefined for `\c`, `\u` and
 * `\U`, whose result depends on the bash version or the locale.
 */
export function ansiC(body: string): string | undefined {
	let out = "";
	for (let at = 0; at < body.length; at++) {
		if (body[at] !== "\\" || at + 1 >= body.length) {
			out += body[at];
			continue;
		}
		const next = body[++at];
		const number =
			/^[0-7]{1,3}/.exec(body.slice(at)) ?? (next === "x" ? /^[0-9a-fA-F]{1,2}/.exec(body.slice(at + 1)) : null);
		if (ANSI_C[next] !== undefined) out += ANSI_C[next];
		else if ("cuU".includes(next)) return undefined;
		else if (number) {
			out += String.fromCharCode(Number.parseInt(number[0], next === "x" ? 16 : 8) & 0xff);
			at += number[0].length - (next === "x" ? 0 : 1);
		} else out += `\\${next}`;
	}
	const nul = out.indexOf("\0");
	return nul < 0 ? out : out.slice(0, nul);
}

/** Index of the `'` closing the ANSI-C quoted string whose body starts at `start` (a `\'` inside does not close it). */
function ansiCEnd(command: string, start: number): number {
	for (let at = start; at < command.length; at++) {
		if (command[at] === "\\") at++;
		else if (command[at] === "'") return at;
	}
	return command.length;
}

/**
 * Whether a `#` at `index` starts a comment: it begins a word (bash reads `a#b`, `$#` and `\ #` as words). After `<` or
 * `>` it is not taken as one: bash then reports a missing redirect target and runs nothing, so keeping the text is safe.
 */
const commentAt = (command: string, index: number): boolean =>
	index === 0 || (/[\s;&|()]/.test(command[index - 1]) && command[index - 2] !== "\\");

/**
 * The command with quotes removed (their content kept as one word, with operators neutralised, ANSI-C `$'…'` escapes
 * decoded, `$"…"` read as `"…"`), comments dropped and each heredoc replaced by a `\u0002<index>` word whose body is
 * pushed onto `bodies`: what is left is what the shell splits into commands.
 */
export function mask(command: string, bodies: string[]): string {
	let out = "";
	const heredocs: Array<{ tag: string; tabs: boolean; index: number; literal: boolean }> = [];
	let index = 0;
	while (index < command.length) {
		const char = command[index];
		if (char === "\n" && heredocs.length > 0) {
			out += "\n";
			index++;
			// Collect body lines up to each pending delimiter, in order.
			const lines: string[] = [];
			const read: typeof heredocs = [];
			while (heredocs.length > 0 && index < command.length) {
				const end = command.indexOf("\n", index);
				const stop = end < 0 ? command.length : end;
				const line = command.slice(index, stop);
				index = stop + 1;
				const { tag, tabs, index: body } = heredocs[0];
				if ((tabs ? line.replace(/^\t+/, "") : line) === tag) {
					bodies[body] = lines.splice(0).join("\n");
					read.push(heredocs.shift()!);
				} else lines.push(line);
			}
			if (heredocs.length > 0) {
				bodies[heredocs[0].index] = lines.join("\n");
				read.push(heredocs[0]);
			}
			// The shell expands an unquoted heredoc body: its substitutions run whether or not the body feeds a shell.
			for (const { index: body, literal } of read) {
				if (!literal)
					out += substitutionsIn(bodies[body] ?? "")
						.map((inner) => `;${mask(inner, bodies)};`)
						.join("");
			}
			continue;
		}
		if (char === "\\") {
			const next = command[index + 1] ?? "";
			out += next === "\n" ? " " : hide(next);
			index += 2;
			continue;
		}
		if (char === "#" && commentAt(command, index)) {
			const end = command.indexOf("\n", index);
			index = end < 0 ? command.length : end;
			continue;
		}
		if (char === "$" && command[index + 1] === "'") {
			const stop = ansiCEnd(command, index + 2);
			const body = command.slice(index + 2, stop);
			out += hide(ansiC(body) ?? body) || hide(" ");
			index = stop + 1;
			continue;
		}
		// `$"…"` is a double-quoted string translated by the locale's message catalog: without one, it is `"…"`.
		if (char === "$" && command[index + 1] === '"') {
			index++;
			continue;
		}
		if (char === "'") {
			const end = command.indexOf("'", index + 1);
			const stop = end < 0 ? command.length : end;
			out += hide(command.slice(index + 1, stop)) || hide(" ");
			index = stop + 1;
			continue;
		}
		if (char === '"') {
			let body = "";
			const substitutions: string[] = [];
			let cursor = index + 1;
			while (cursor < command.length && command[cursor] !== '"') {
				if (command[cursor] === "\\" && cursor + 1 < command.length) {
					body += command[cursor + 1];
					cursor += 2;
				} else if (command.startsWith("$(", cursor) || command[cursor] === "`") {
					// `$(…)` and backticks run even inside double quotes: check their body as separate commands.
					const end = substitutionEnd(command, cursor);
					substitutions.push(command.slice(cursor + (command[cursor] === "`" ? 1 : 2), end));
					cursor = end + 1;
				} else body += command[cursor++];
			}
			out += (hide(body) || hide(" ")) + substitutions.map((inner) => `;${mask(inner, bodies)};`).join("");
			index = cursor + 1;
			continue;
		}
		const heredoc = char === "<" && command[index - 1] !== "<" ? HEREDOC.exec(command.slice(index)) : null;
		if (heredoc && command[index + 2] !== "<") {
			heredocs.push({
				tag: heredoc[3],
				tabs: heredoc[1] === "-",
				index: bodies.length,
				literal: heredoc[2] !== "",
			});
			bodies.push("");
			out += ` \u0002${bodies.length - 1} `;
			index += heredoc[0].length;
			continue;
		}
		out += char;
		index++;
	}
	return out;
}

/** Index of the character closing the `$(…)` or backtick substitution that starts at `start`. */
function substitutionEnd(command: string, start: number): number {
	if (command[start] === "`") {
		const end = command.indexOf("`", start + 1);
		return end < 0 ? command.length : end;
	}
	let depth = 0;
	for (let at = start + 1; at < command.length; at++) {
		if (command[at] === "\\") at++;
		else if (command[at] === "(") depth++;
		else if (command[at] === ")" && --depth === 0) return at;
	}
	return command.length;
}

/** The bodies of the unescaped `$(…)` and backtick substitutions in `text` (an unquoted heredoc body). */
function substitutionsIn(text: string): string[] {
	const found: string[] = [];
	for (let at = 0; at < text.length; at++) {
		if (text[at] === "\\") at++;
		else if (text.startsWith("$(", at) || text[at] === "`") {
			const end = substitutionEnd(text, at);
			found.push(text.slice(at + (text[at] === "`" ? 1 : 2), end));
			at = end;
		}
	}
	return found;
}

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
