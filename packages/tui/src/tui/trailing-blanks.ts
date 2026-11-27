/**
 * Trailing blank cells need no bytes on a row that was just erased: `ESC[2K` leaves default-background blanks,
 * so plain spaces at the end of the row only cost bandwidth. Spaces drawn with a background, reverse video,
 * underline, strikethrough or overline stay, because the terminal shows them. SGR codes are kept untouched.
 */

const SGR = /\x1b\[([0-9;:]*)m/g;
const ESC = "\x1b";
const BEL = "\x07";

function isSpaces(token: string): boolean {
	return token[0] === " ";
}

function isSgrParameter(char: string): boolean {
	return (char >= "0" && char <= "9") || char === ";" || char === ":";
}

/**
 * Start of the token that ends at `end` (exclusive), or -1. Tokens are a space, an SGR code (`ESC [ params m`) and
 * an OSC 8 hyperlink code (`ESC ] 8 ; ... BEL` or `... ESC \`). Each token's start is fixed by its last character,
 * so reading tokens backwards finds the same tail as matching `(?:token)+$` from the leftmost start, in time linear
 * in the tail instead of the whole row: rows are trimmed for every frame, so this runs thousands of times a second
 * while scrolling.
 */
function tokenStart(line: string, end: number): number {
	const last = line[end - 1];
	if (last === " ") {
		// A run of spaces has one style, so it is one token: rows padded to the full width cost one step.
		let start = end - 1;
		while (start > 0 && line[start - 1] === " ") start--;
		return start;
	}
	if (last === "m") {
		let index = end - 2;
		while (index >= 0 && isSgrParameter(line[index] ?? "")) index--;
		return index >= 1 && line[index] === "[" && line[index - 1] === ESC ? index - 1 : -1;
	}
	let bodyEnd: number;
	if (last === BEL) bodyEnd = end - 1;
	else if (last === "\\" && line[end - 2] === ESC) bodyEnd = end - 2;
	else return -1;
	const start = line.lastIndexOf(ESC, bodyEnd - 1);
	if (start < 0 || !line.startsWith("]8;", start + 1)) return -1;
	const body = line.slice(start + 4, bodyEnd);
	return body.includes(BEL) || body.includes(ESC) ? -1 : start;
}

/**
 * The tokens that end the row, in order, and where they start; no tokens when the row ends in visible text. A token
 * is a run of spaces or one control code.
 */
function trailingTokens(line: string): { start: number; tokens: string[] } {
	const tokens: string[] = [];
	let end = line.length;
	for (let start = tokenStart(line, end); start >= 0; start = tokenStart(line, end)) {
		tokens.push(line.slice(start, end));
		end = start;
	}
	return { start: end, tokens: tokens.reverse() };
}

/** Attributes that make a space visible. */
interface SpaceStyle {
	background: boolean;
	reverse: boolean;
	underline: boolean;
	strike: boolean;
	overline: boolean;
}

function plain(style: SpaceStyle): boolean {
	return !(style.background || style.reverse || style.underline || style.strike || style.overline);
}

function applySgr(style: SpaceStyle, params: string): void {
	const parts = params === "" ? ["0"] : params.split(";");
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i] ?? "";
		if (part.includes(":")) {
			const head = part.slice(0, part.indexOf(":"));
			if (head === "48") style.background = true;
			else if (head === "4") style.underline = part !== "4:0";
			continue;
		}
		const code = part === "" ? 0 : Number(part);
		if (code === 38 || code === 48 || code === 58) {
			if (code === 48) style.background = true;
			const mode = parts[i + 1];
			i += mode === "5" ? 2 : mode === "2" ? 4 : 0;
			continue;
		}
		if (code === 0) {
			style.background = false;
			style.reverse = false;
			style.underline = false;
			style.strike = false;
			style.overline = false;
		} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) style.background = true;
		else if (code === 49) style.background = false;
		else if (code === 7) style.reverse = true;
		else if (code === 27) style.reverse = false;
		else if (code === 4 || code === 21) style.underline = true;
		else if (code === 24) style.underline = false;
		else if (code === 9) style.strike = true;
		else if (code === 29) style.strike = false;
		else if (code === 53) style.overline = true;
		else if (code === 55) style.overline = false;
	}
}

function scanStyle(style: SpaceStyle, text: string): void {
	SGR.lastIndex = 0;
	for (let match = SGR.exec(text); match; match = SGR.exec(text)) applySgr(style, match[1] ?? "");
}

/** Drop the plain spaces that end a row; the result paints the same cells when the row was erased first. */
export function trimTrailingBlanks(line: string): string {
	const { start: tailStart, tokens } = trailingTokens(line);
	if (!tokens.some(isSpaces)) return line;
	const style: SpaceStyle = { background: false, reverse: false, underline: false, strike: false, overline: false };
	scanStyle(style, line.slice(0, tailStart));
	let lastVisible = -1;
	tokens.forEach((token, index) => {
		if (isSpaces(token)) {
			if (!plain(style)) lastVisible = index;
		} else if (token.startsWith("\x1b[")) applySgr(style, token.slice(2, -1));
	});
	let result = line.slice(0, tailStart);
	tokens.forEach((token, index) => {
		if (!isSpaces(token) || index <= lastVisible) result += token;
	});
	return result;
}

/** Two rows that paint the same cells once erased. */
export function sameRowAfterErase(a: string, b: string): boolean {
	return a === b || trimTrailingBlanks(a) === trimTrailingBlanks(b);
}
