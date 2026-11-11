/**
 * Reads a shell command line up to the cursor the way a POSIX shell splits it: quotes, backslash escapes, command
 * separators (`|`, `||`, `&&`, `;`, `&`, newline) and command substitution (`$(`, backticks, `(`). It never runs or expands
 * anything; it only finds the command the cursor is in and the word being typed.
 */

/** Where the cursor is in a command line. */
export interface ShellLine {
	/** Offset of the first character of the command the cursor is in. */
	segmentStart: number;
	/** Unquoted words of that command before the word being typed; leading `NAME=value` assignments are left out. */
	words: string[];
	/** The word being typed as written (quotes and escapes kept), possibly empty. */
	current: string;
	/** Offset where `current` starts. */
	currentStart: number;
	/** The word being typed with quotes and escapes removed. */
	currentValue: string;
	/** The quote still open at the cursor, if any. */
	openQuote?: "'" | '"';
	/** True when the word being typed is the command name (no words before it). */
	commandPosition: boolean;
}

const SEPARATOR_CHARS = new Set(["|", "&", ";", "\n", "(", ")", "`"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface Word {
	raw: string;
	value: string;
	start: number;
}

/** Splits `text` (everything before the cursor) and returns the command and word at its end. */
export function parseShellLine(text: string): ShellLine {
	let segmentStart = 0;
	let words: Word[] = [];
	let raw = "";
	let value = "";
	let start = -1;
	let quote: "'" | '"' | undefined;
	const endWord = () => {
		if (start >= 0) words.push({ raw, value, start });
		raw = "";
		value = "";
		start = -1;
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote === "'") {
			raw += ch;
			if (ch === "'") quote = undefined;
			else value += ch;
			continue;
		}
		if (quote === '"') {
			raw += ch;
			if (ch === '"') quote = undefined;
			else if (ch === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) {
				raw += text[++i];
				value += text[i];
			} else if (ch === "$" && text[i + 1] === "(") {
				// A substitution inside double quotes starts a new command.
				endWord();
				quote = undefined;
				i++;
				segmentStart = i + 1;
				words = [];
			} else value += ch;
			continue;
		}
		if (ch === "\\") {
			if (start < 0) start = i;
			raw += ch;
			if (i + 1 < text.length) {
				raw += text[++i];
				if (text[i] !== "\n") value += text[i];
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			if (start < 0) start = i;
			quote = ch;
			raw += ch;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(") {
			endWord();
			i++;
			segmentStart = i + 1;
			words = [];
			continue;
		}
		if (SEPARATOR_CHARS.has(ch)) {
			endWord();
			// `|&`, `||`, `&&`, `;;` and `>&` are one operator; a redirection `>&` is not a separator.
			if (ch === "&" && (text[i - 1] === ">" || text[i - 1] === "<")) continue;
			while (i + 1 < text.length && SEPARATOR_CHARS.has(text[i + 1]) && text[i + 1] !== "(" && text[i + 1] !== "`") i++;
			segmentStart = i + 1;
			words = [];
			continue;
		}
		if (ch === " " || ch === "\t") {
			endWord();
			continue;
		}
		if (start < 0) start = i;
		raw += ch;
		value += ch;
	}
	const typing = start >= 0;
	const current = typing ? raw : "";
	const currentStart = typing ? start : text.length;
	const currentValue = typing ? value : "";
	let leading = 0;
	while (leading < words.length && ASSIGNMENT.test(words[leading].raw)) leading++;
	const commandWords = words.slice(leading).map((word) => word.value);
	const assignmentTyped = commandWords.length === 0 && ASSIGNMENT.test(current);
	return {
		segmentStart: Math.min(segmentStart, text.length),
		words: commandWords,
		current,
		currentStart,
		currentValue,
		...(quote ? { openQuote: quote } : {}),
		commandPosition: commandWords.length === 0 && !assignmentTyped,
	};
}

/** Characters a shell treats specially in an unquoted word. */
const UNSAFE = /[\s'"\\$`!&|;<>(){}[\]*?#]/;

/**
 * `value` written so the shell reads it back unchanged. Inside an open quote it is escaped for that quote and the quote
 * stays open when `keepOpen` (a directory the user goes on typing into); otherwise unsafe characters get a backslash.
 * A leading `~` or `~user` stays unescaped, so the shell still expands it.
 */
export function quoteForShell(value: string, openQuote?: "'" | '"', keepOpen = false): string {
	if (openQuote === "'") return `'${value.replaceAll("'", "'\\''")}${keepOpen ? "" : "'"}`;
	if (openQuote === '"') return `"${value.replace(/["\\$`]/g, "\\$&")}${keepOpen ? "" : '"'}`;
	if (!UNSAFE.test(value)) return value;
	const tilde = /^~[A-Za-z0-9._-]*(?=\/|$)/.exec(value)?.[0] ?? "";
	return tilde + value.slice(tilde.length).replace(/[\s'"\\$`!&|;<>(){}[\]*?#]/g, "\\$&");
}
