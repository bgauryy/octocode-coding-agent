#!/usr/bin/env node
/**
 * Lists the terminal features a TUI used, from the raw bytes `pty-drive.py` recorded (`terminal.raw`): DEC private modes
 * set and reset, OSC sequences, keyboard protocols, queries and drawing primitives, each with a count.
 *
 *   node scripts/agent-capture/esc-report.mjs <terminal.raw>...
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MODES = {
	1: "app cursor keys",
	7: "autowrap",
	12: "cursor blink",
	25: "cursor visible",
	47: "alt screen (old)",
	66: "app keypad",
	1000: "mouse click",
	1002: "mouse drag",
	1003: "mouse any",
	1004: "focus events",
	1006: "mouse SGR",
	1007: "alt scroll",
	1049: "alt screen",
	2004: "bracketed paste",
	2026: "synchronized output",
	2027: "grapheme clusters",
	2031: "color-scheme reports",
	2048: "in-band resize",
};
const OSC = {
	0: "title",
	2: "title",
	4: "palette",
	7: "cwd",
	8: "hyperlink",
	9: "notify/progress (9;4)",
	10: "fg color query",
	11: "bg color query",
	22: "pointer shape",
	52: "clipboard",
	99: "kitty notify",
	133: "semantic prompt",
	777: "notify",
	1337: "iTerm2",
	7501: "program status",
};
const OTHER = {
	"kitty keyboard push CSI >Nu": /\x1b\[>\d+u/g,
	"kitty keyboard query CSI ?u": /\x1b\[\?u/g,
	"kitty keyboard pop CSI <u": /\x1b\[<\d*u/g,
	"modifyOtherKeys CSI >4;Nm": /\x1b\[>4;\d+m/g,
	"XTVERSION CSI >q": /\x1b\[>0?q/g,
	"DA1 CSI c": /\x1b\[0?c/g,
	"DECRQM mode query CSI ?N$p": /\x1b\[\?\d+\$p/g,
	"cursor position query CSI 6n": /\x1b\[6n/g,
	"scroll region DECSTBM": /\x1b\[\d+;\d+r/g,
	"erase display CSI 2J": /\x1b\[2J/g,
	"erase scrollback CSI 3J": /\x1b\[3J/g,
	"erase line CSI K": /\x1b\[[012]?K/g,
	"cursor up CSI nA": /\x1b\[\d*A/g,
	"absolute move CSI r;cH": /\x1b\[\d+;\d+H/g,
	"insert/delete line CSI nL/M": /\x1b\[\d*[LM]/g,
	"scroll up/down CSI nS/T": /\x1b\[\d*[ST]/g,
	"cursor shape DECSCUSR": /\x1b\[\d q/g,
	"save/restore cursor ESC 7/8": /\x1b[78]/g,
	"truecolor SGR 38;2": /\x1b\[[0-9;]*38;2;/g,
	"256 color SGR 38;5": /\x1b\[[0-9;]*38;5;/g,
	"window ops CSI t": /\x1b\[[\d;]+t/g,
};

/** The report lines for one recording. */
export function escapeReport(text) {
	const lines = [];
	const modes = new Map();
	for (const [, numbers, action] of text.matchAll(/\x1b\[\?([0-9;]+)([hl])/g))
		for (const mode of numbers.split(";")) modes.set(`${mode}${action}`, (modes.get(`${mode}${action}`) ?? 0) + 1);
	for (const [key, count] of [...modes].sort(
		([a], [b]) => Number.parseInt(a) - Number.parseInt(b) || a.localeCompare(b),
	))
		lines.push(`DECSET ?${key} x${count}  ${MODES[Number.parseInt(key)] ?? ""}`.trimEnd());
	const oscs = new Map();
	for (const [, code] of text.matchAll(/\x1b\](\d+)[;\x07]/g)) oscs.set(code, (oscs.get(code) ?? 0) + 1);
	for (const [code, count] of oscs) lines.push(`OSC ${code} x${count}  ${OSC[code] ?? ""}`.trimEnd());
	for (const [label, pattern] of Object.entries(OTHER)) {
		const count = text.match(pattern)?.length ?? 0;
		if (count > 0) lines.push(`${label} x${count}`);
	}
	return lines;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename)
	for (const path of process.argv.slice(2)) {
		const bytes = readFileSync(path);
		console.log(`== ${path}  (${bytes.length.toLocaleString("en-US")} bytes)`);
		for (const line of escapeReport(bytes.toString("utf8"))) console.log(`  ${line}`);
	}
