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
