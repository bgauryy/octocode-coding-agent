/**
 * Text from subagents and MCP servers is untrusted: an escape sequence in it could retitle the terminal, write a
 * clickable link (OSC 8), move the cursor or reorder text with bidi overrides. `sanitizeTerminalText` strips those
 * from text a person reads; `visibleControls` shows them as escapes in text the model reads. Adapted from the native composer's paste sanitiser.
 *
 * Which one: text that only a terminal or UI draws (a panel row, a label) goes through `sanitizeTerminalText`; any text
 * that reaches the model (a message body, a fenced body, a tool result) goes through `visibleControls`, which keeps the evidence
 * and is safe to draw too. An approval dialog shows what the user is asked to allow, so it uses `visibleControls` as well: a hidden or
 * bidi character stays visible instead of vanishing. `visibleControls` is not injective: a literal `\u{200d}` typed in the text and an escaped ZWJ read the
 * same. That is accepted: the escape exists so a reader can see that something was there, not to round-trip the text.
 */
// An unterminated string ends at its line: a stray introducer must not swallow the rest of the text.
const OSC_SEQUENCE = /(?:\u001b\]|\u009d)[^\n]*?(?:\u0007|\u001b\\|\u009c|(?=\n)|$)/gu;
/** DCS, SOS, PM and APC strings. */
const TERMINAL_STRING_SEQUENCE = /(?:\u001b[P_X^]|[\u0090\u0098\u009e\u009f])[^\n]*?(?:\u001b\\|\u009c|(?=\n)|$)/gu;
const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu;
const ESC_SEQUENCE = /\u001b[ -/]*[0-~]/gu;
/** C0 and C1 controls except \t and \n (\r is folded into \n first). */
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const BIDI_FORMATTING = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/gu;
/**
 * Invisible characters that can smuggle text past a reader: Unicode tags (U+E0000–E007F), zero-width space and
 * non-joiner, word joiner and invisible operators (U+2060–2064), the soft hyphen (U+00AD), the combining grapheme joiner
 * (U+034F), the Khmer inherent vowels (U+17B4–17B5), the Mongolian free variation selectors and vowel separator
 * (U+180B–180E), the braille blank (U+2800), the Hangul fillers (U+3164, U+FFA0), the BOM, a zero-width joiner unless it
 * joins two emoji (👩‍💻 keeps its ZWJ), and a variation selector (U+FE00–FE0F, U+E0100–E01EF) unless it directly follows
 * a character it is meant to modify (an emoji, a Han ideograph, a digit, `#` or `*`): a run of them hides data.
 */
const INVISIBLE =
	// biome-ignore lint/suspicious/noMisleadingCharacterClass: Intentional literal fixture or exact Unicode character matching.
	// oxlint-disable-next-line no-misleading-character-class -- each escaped code point (combining marks, selectors, skin tones) is matched on its own; still reported with the u and v flags
	/[\u00ad\u034f\u17b4\u17b5\u180b-\u180e\u200b\u200c\u2060-\u2064\u2800\u3164\uffa0\ufeff\u{e0000}-\u{e007f}]|(?<![\p{Extended_Pictographic}\p{Script=Han}\p{Nd}#*\u{1f3fb}-\u{1f3ff}])[\ufe00-\ufe0f\u{e0100}-\u{e01ef}]|(?<!\p{Extended_Pictographic}[\u{1f3fb}-\u{1f3ff}\ufe0f]?)\u200d|\u200d(?!\p{Extended_Pictographic})/gu;

/** Anything `sanitizeTerminalText` or `visibleControls` may change: most output holds none of it. */
const NEEDS_CLEANING =
	// biome-ignore lint/suspicious/noMisleadingCharacterClass: Intentional literal fixture or exact Unicode character matching.
	// oxlint-disable-next-line no-misleading-character-class -- each escaped code point (combining marks, selectors, skin tones) is matched on its own; still reported with the u and v flags
	/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2064\u2066-\u206f\u2800\u3164\ufe00-\ufe0f\uffa0\ufeff\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u;
/**
 * Every character `visibleControls` makes visible: the controls (a CR not followed by LF; CRLF stays), bidi formatting,
 * invisible characters and line/paragraph separators.
 */
const HIDDEN = new RegExp(
	`\\r(?!\\n)|[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u2028\\u2029]|${BIDI_FORMATTING.source}|${INVISIBLE.source}`,
	"gu",
);

/** Text for the terminal or a UI: control sequences, bidi and invisible characters are removed, and CR and CRLF become LF. */
export function sanitizeTerminalText(value: string): string {
	if (!NEEDS_CLEANING.test(value)) return value;
	return value
		.replace(OSC_SEQUENCE, "")
		.replace(TERMINAL_STRING_SEQUENCE, "")
		.replace(CSI_SEQUENCE, "")
		.replace(ESC_SEQUENCE, "")
		.replace(BIDI_FORMATTING, "")
		.replace(INVISIBLE, "")
		.replace(/\r\n?/gu, "\n")
		.replace(/[\u2028\u2029]/gu, "\n")
		.replace(UNSAFE_CONTROLS, "");
}

/** Well-formed SGR (color and style) sequences: `ESC [ <digits;:> m`. */
const SGR = /\u001b\[[0-9;:]*m/g;
/** The same, captured, so `split` keeps each sequence as its own part. */
const SGR_PART = /(\u001b\[[0-9;:]*m)/u;

/**
 * One row of text that may carry colours (a status or working message): colour and style sequences stay, every other
 * control (a title, a link, a cursor move, bidi) is removed, and line breaks and tabs become single spaces, since a
 * break inside a footer or status row breaks the renderer's row tracking.
 */
export function styledLine(text: string): string {
	return text
		.split(SGR_PART)
		.map((part, index) => (index % 2 === 1 ? part : sanitizeTerminalText(part)))
		.join("")
		.replace(/[\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Removes color and style sequences only, as Octocode's bash does for its output: they carry no evidence. Any other control
 * (cursor moves, titles, a malformed sequence) is left for `visibleControls` to show.
 */
export function withoutColors(value: string): string {
	return value.replace(SGR, "");
}

/**
 * Text for the model that the terminal can also draw: evidence is kept, not removed. Every control character (ESC and
 * the C1 controls that start a terminal sequence, NUL, DEL), bidi formatting character, invisible character (zero-width,
 * BOM, Unicode tags, a ZWJ that joins no emoji) and line or paragraph separator becomes a visible escape, `\u{200d}`;
 * a lone carriage return (one not followed by a line feed) becomes `\r`, so it stays visible and can never rewrite the
 * line on the terminal. A CRLF pair stays as it is: it is harmless to a terminal, and a CRLF file keeps its size and
 * its exact text (an edit built from the text matches the file). Tabs, newlines and emoji joiners stay too. Nothing
 * raw that can steer a terminal or reorder text remains. Use `sanitizeTerminalText` for text that only a person reads.
 */
export function visibleControls(value: string): string {
	if (!NEEDS_CLEANING.test(value)) return value;
	return value.replace(HIDDEN, (char) => (char === "\r" ? "\\r" : `\\u{${char.codePointAt(0)!.toString(16)}}`));
}

/**
 * Text as stored in a database: sanitized and trimmed, and whole. `max` is for one-line labels only (a goal, an
 * activity line, a model id) whose width the UI bounds; content (titles, bodies, notes) is never cut.
 */
export function storedText(text: string | undefined, max?: number): string {
	const stored = sanitizeTerminalText(text ?? "").trim();
	// By code point, so an emoji at the edge is never cut in half (this module cannot import `cutText`: it imports us).
	// oxlint-disable-next-line typescript/no-misused-spread -- a code-point cut is intended; labels are bounded by width, not graphemes
	return max === undefined ? stored : [...stored].slice(0, max).join("");
}

/** The credential word of an assignment; `secret` also takes its usual tails (`AWS_SECRET_ACCESS_KEY`, `CLIENT_SECRET_KEY`). */
const SECRET_ASSIGNMENT_NAME = "(?:password|passwd|secret(?:[_-](?:access[_-])?key)?|api[_-]?key|token)";
/**
 * Where that word may start: `\b` never holds after `_`, so `GH_TOKEN=…` and `DB_PASSWORD=…` went unseen. The closing
 * quote of a JSON key may sit before the separator (`{"api_key":"…"}`).
 */
const SECRET_ASSIGNMENT = `(?<![A-Za-z0-9])${SECRET_ASSIGNMENT_NAME}["']?\\s*`;
const PRIVATE_KEY_BLOCK = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/;
const PRIVATE_KEY_BLOCKS = new RegExp(PRIVATE_KEY_BLOCK.source, "g");
const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[PRIVATE_KEY_BLOCK, "a private key"],
	[/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, "an AWS access key id"],
	[/\bghp_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bgh[ousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
	[/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/, "an API secret key (sk-…)"],
	[/\bxox[bpas]-[A-Za-z0-9-]{10,}/, "a Slack token"],
	[/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "a JWT"],
	[/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/, "a Stripe key"],
	[/\bAIza[0-9A-Za-z_-]{35}/, "a Google API key"],
	[/\bnpm_[A-Za-z0-9]{36}/, "an npm token"],
	[/\bglpat-[A-Za-z0-9_-]{20,}/, "a GitLab token"],
	[/\bgsk_[A-Za-z0-9]{20,}/, "a Groq API key"],
	[/\bhf_[A-Za-z0-9]{20,}/, "a Hugging Face token"],
	// `scheme://user:password@host`; `${VAR}` or `<placeholder>` passwords are templates, not secrets.
	[/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/${}<>]{3,}@/i, "a password in a URL"],
	// `password = s3cretValue`: the value must hold a digit and no code punctuation, so `token = getToken()` passes.
	[
		new RegExp(`${SECRET_ASSIGNMENT}[:=]\\s*['"]?(?=[^\\s'"(){}<>,;$]*\\d)[^\\s'"(){}<>,;$]{8,}`, "i"),
		"a password or key assignment",
	],
	[/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, "a bearer token"],
];

/** Each pattern once, with its global twin for replacing: built at load, not on every call. */
const SECRETS = SECRET_PATTERNS.map(([pattern, what]) => ({
	pattern,
	what,
	all: new RegExp(pattern.source, `${pattern.flags}g`),
}));

const SECRET_LINE_CONTINUATION = new RegExp(`(?:${SECRET_ASSIGNMENT}(?:[:=]\\s*)?|\\bBearer\\s*)$`, "i");

/** Outside a PEM block, only assignments and Bearer credentials can continue across a newline. */
export function secretContinuesAfterLine(text: string): boolean {
	return SECRET_LINE_CONTINUATION.test(text);
}

/** Matching footer for an unfinished PEM block; an empty footer means its oversized identity must stay withheld. */
export function unfinishedPrivateKey(text: string): string | undefined {
	for (const match of text.matchAll(PRIVATE_KEY_BLOCKS)) {
		const footer = `-----END ${match[1]}-----`;
		if (!match[0].endsWith(footer)) return footer.length <= 300 ? footer : "";
	}
	return undefined;
}

/** Redact a logical stream while keeping its fragment boundaries and metadata associations. */
export function redactSecretFragments(fragments: readonly string[]): string[] {
	const text = fragments.join("");
	const ranges = SECRETS.flatMap(({ all }) =>
		Array.from(text.matchAll(all), (match) => ({ start: match.index, end: match.index + match[0].length })),
	).sort((left, right) => left.start - right.start);
	const merged: Array<{ start: number; end: number }> = [];
	for (const range of ranges) {
		const last = merged.at(-1);
		if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
		else merged.push(range);
	}
	let offset = 0;
	let rangeIndex = 0;
	return fragments.map((fragment) => {
		const start = offset;
		const end = (offset += fragment.length);
		let cursor = start;
		let result = "";
		while (rangeIndex < merged.length && merged[rangeIndex].end <= start) rangeIndex++;
		for (let index = rangeIndex; index < merged.length; index++) {
			const range = merged[index];
			if (range.start >= end) break;
			result += text.slice(cursor, Math.max(cursor, range.start));
			if (range.start >= start) result += "[redacted]";
			cursor = Math.min(end, range.end);
		}
		return result + text.slice(cursor, end);
	});
}

/** Why `text` must not be stored (it looks like it holds a credential), or undefined when it looks clean. */
export function secretProblem(text: string): string | undefined {
	const hit = SECRETS.find(({ pattern }) => pattern.test(text));
	return hit
		? `it looks like it contains ${hit.what}; never store secrets — refer to where the secret lives instead`
		: undefined;
}

/**
 * The first of `fields` (a text, or lines joined by a space; empty and missing ones are skipped) that looks like it holds a
 * credential, as `{ name, problem }`; undefined when none does. Checked on the sanitized text, the form that is stored, so
 * an invisible character cannot split a token past the check. A store throws its own error from it.
 */
export function storedSecret(
	fields: Record<string, string | readonly string[] | undefined>,
): { name: string; problem: string } | undefined {
	for (const [name, value] of Object.entries(fields)) {
		const text = typeof value === "string" ? value : value?.join(" ");
		const problem = text ? secretProblem(sanitizeTerminalText(text)) : undefined;
		if (problem) return { name, problem };
	}
	return undefined;
}

/** `text` with every credential-looking span replaced by `[redacted]`, for text drawn on screen or shared with other sessions. */
export function redactSecrets(text: string): string {
	return SECRETS.reduce((out, { all }) => out.replace(all, "[redacted]"), text);
}

/** Apply the same credential policy to JSON evidence without changing its field names or shape. */
export function redactData<T>(value: T): T {
	return JSON.parse(
		JSON.stringify(value, (_key, entry: unknown) => (typeof entry === "string" ? redactSecrets(entry) : entry)),
	) as T;
}
