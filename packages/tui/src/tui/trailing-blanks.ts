/**
 * Trailing blank cells need no bytes on a row that was just erased: `ESC[2K` leaves default-background blanks,
 * so plain spaces at the end of the row only cost bandwidth. Spaces drawn with a background, reverse video,
 * underline, strikethrough or overline stay, because the terminal shows them. SGR codes are kept untouched.
 */

const SGR = /\x1b\[([0-9;:]*)m/g;
const TOKEN = " |\\x1b\\[[0-9;:]*m|\\x1b\\]8;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)";
const TAIL = new RegExp(`(?:${TOKEN})+$`);

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
			style.background = style.reverse = style.underline = style.strike = style.overline = false;
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
	if (!TAIL.test(line)) return line;
	const tailStart = TAIL.exec(line)?.index ?? line.length;
	const tail = line.slice(tailStart);
	if (!tail.includes(" ")) return line;
	const style: SpaceStyle = { background: false, reverse: false, underline: false, strike: false, overline: false };
	scanStyle(style, line.slice(0, tailStart));
	const tokens = tail.match(new RegExp(TOKEN, "g")) ?? [];
	let lastVisible = -1;
	tokens.forEach((token, index) => {
		if (token === " ") {
			if (!plain(style)) lastVisible = index;
		} else if (token.startsWith("\x1b[")) applySgr(style, token.slice(2, -1));
	});
	let result = line.slice(0, tailStart);
	tokens.forEach((token, index) => {
		if (token !== " " || index <= lastVisible) result += token;
	});
	return result;
}

/** Two rows that paint the same cells once erased. */
export function sameRowAfterErase(a: string, b: string): boolean {
	return a === b || trimTrailingBlanks(a) === trimTrailingBlanks(b);
}
