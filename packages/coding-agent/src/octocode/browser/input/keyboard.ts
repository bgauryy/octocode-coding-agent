import type { BrowserSession } from "../cdp.ts";

type Page = BrowserSession["page"];
const MODIFIERS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const KEY_CODES: Record<string, number> = {
	Enter: 13,
	Tab: 9,
	Escape: 27,
	Backspace: 8,
	Delete: 46,
	" ": 32,
	Space: 32,
	ArrowLeft: 37,
	ArrowUp: 38,
	ArrowRight: 39,
	ArrowDown: 40,
	Home: 36,
	End: 35,
	PageUp: 33,
	PageDown: 34,
};
/** Editing shortcuts Chrome only performs when asked for by command name (a synthetic Ctrl/Cmd+A selects nothing otherwise). */
const EDIT_COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

/**
 * Presses `combo`: one key (`Enter`, `a`, `ArrowDown`) or modifiers joined with `+` (`Control+A`, `Shift+Tab`,
 * `Meta+Enter`). Printable keys type their character unless Control or Meta is held.
 */
export async function pressKey(page: Page, combo: string, signal?: AbortSignal): Promise<void> {
	const literalPlus = combo === "+" || combo.endsWith("++");
	const parts = (literalPlus ? combo.slice(0, -1) : combo).split("+").map((part) => part.trim());
	const named = literalPlus ? "+" : parts.at(-1) || combo;
	let modifiers = 0;
	for (const part of parts.slice(0, -1)) {
		const bit = MODIFIERS[part.toLowerCase()];
		if (bit === undefined)
			throw new Error(`Unknown modifier "${part}" in "${combo}"; use Alt, Control, Meta or Shift.`);
		modifiers |= bit;
	}
	const key = named === "Space" ? " " : named;
	const printable = key.length === 1;
	const code = !printable
		? key
		: /\d/.test(key)
			? `Digit${key}`
			: /[a-z]/i.test(key)
				? `Key${key.toUpperCase()}`
				: key === " "
					? "Space"
					: key;
	const shortcut = (modifiers & (2 | 4)) !== 0;
	const text = key === "Enter" ? "\r" : printable && !shortcut ? (modifiers & 8 ? key.toUpperCase() : key) : undefined;
	const keyCode = KEY_CODES[key] ?? (printable ? key.toUpperCase().charCodeAt(0) : undefined);
	const command = shortcut && printable ? EDIT_COMMANDS[key.toLowerCase()] : undefined;
	const base = { key, code, modifiers, ...(keyCode !== undefined ? { windowsVirtualKeyCode: keyCode } : {}) };
	await page.send(
		"Input.dispatchKeyEvent",
		{
			type: text ? "keyDown" : "rawKeyDown",
			...base,
			...(text ? { text } : {}),
			...(command ? { commands: [command] } : {}),
		},
		signal,
	);
	await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, signal);
}
