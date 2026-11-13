/**
 * Seeded terminal input for differential tests of key matching and input buffering: printable characters, control
 * bytes, legacy, Kitty CSI-u (alternate keys, modifiers, press/repeat/release), modifyOtherKeys, arrows and functional
 * keys, mouse reports, terminal replies and bracketed pastes. Changing a generator changes every golden made from it.
 */

/** mulberry32: a small deterministic PRNG. */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)];

const CODEPOINTS = [
	9, 13, 27, 32, 33, 43, 45, 47, 48, 49, 59, 61, 65, 90, 91, 92, 93, 95, 96, 97, 99, 100, 107, 112, 122, 127, 1089,
	57399, 57414,
];
const MODIFIERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 65, 129, 66];
const EVENTS = ["", ":1", ":2", ":3"];
const LEGACY = [
	"\x1b[A",
	"\x1b[B",
	"\x1b[C",
	"\x1b[D",
	"\x1bOA",
	"\x1b[H",
	"\x1b[F",
	"\x1bOH",
	"\x1b[1~",
	"\x1b[4~",
	"\x1b[2~",
	"\x1b[3~",
	"\x1b[5~",
	"\x1b[6~",
	"\x1b[Z",
	"\x1bOP",
	"\x1b[15~",
	"\x1b[24~",
	"\x1b[E",
	"\x1bOE",
	"\x1b[a",
	"\x1b[c",
	"\x1b[2$",
	"\x1b[3^",
	"\x1bOM",
	"\x1b\r",
	"\x1b\x7f",
	"\x1b\b",
	"\x1b ",
	"\x1bb",
	"\x1bf",
	"\x1bB",
	"\x1bF",
	"\x1bp",
	"\x1bn",
	"\x1b\x1b",
];

/** One key event as a terminal sends it. */
export function randomKey(random: () => number): string {
	const kind = Math.floor(random() * 10);
	if (kind === 0) return String.fromCharCode(32 + Math.floor(random() * 95));
	if (kind === 1) return String.fromCharCode(Math.floor(random() * 32));
	if (kind === 2) return pick(random, ["\x7f", "\x08", "\x00", "é", "世", "，", "\u{1F600}"]);
	if (kind === 3) return pick(random, LEGACY);
	if (kind === 4) return `\x1b${String.fromCharCode(32 + Math.floor(random() * 95))}`;
	if (kind === 5) return `\x1b${String.fromCharCode(1 + Math.floor(random() * 26))}`;
	if (kind === 6) {
		const cp = pick(random, CODEPOINTS);
		const alt =
			random() < 0.3
				? `:${pick(random, ["", "43", "65", "33"])}${random() < 0.3 ? `:${pick(random, CODEPOINTS)}` : ""}`
				: "";
		const mod = random() < 0.7 ? `;${pick(random, MODIFIERS)}${pick(random, EVENTS)}` : "";
		return `\x1b[${cp}${alt}${mod}u`;
	}
	if (kind === 7)
		return `\x1b[1;${pick(random, MODIFIERS)}${pick(random, EVENTS)}${pick(random, ["A", "B", "C", "D", "H", "F"])}`;
	if (kind === 8)
		return `\x1b[${pick(random, [2, 3, 5, 6, 7, 8])}${random() < 0.7 ? `;${pick(random, MODIFIERS)}${pick(random, EVENTS)}` : ""}~`;
	return `\x1b[27;${pick(random, MODIFIERS)};${pick(random, CODEPOINTS)}~`;
}

/** Input bytes mixing keys, typed text, mouse reports, terminal replies and bracketed pastes. */
export function randomStream(random: () => number, events: number): string {
	let out = "";
	for (let i = 0; i < events; i++) {
		const kind = random();
		if (kind < 0.45) out += randomKey(random);
		else if (kind < 0.75)
			out += pick(random, ["hello world ", "a", "abc@src/x ", "/help ", '"q t"', "世界，好", "x\u{1F600}y", "  "]);
		else if (kind < 0.82)
			out += `\x1b[<${Math.floor(random() * 64)};${1 + Math.floor(random() * 80)};${1 + Math.floor(random() * 24)}${pick(random, ["M", "m"])}`;
		else if (kind < 0.88)
			out += pick(random, [
				"\x1b[?62;22c",
				"\x1b[?7u",
				"\x1b]11;rgb:0000/0000/0000\x1b\\",
				"\x1b_Gi=1;OK\x1b\\",
				"\x1b[?2026;2$y",
			]);
		else if (kind < 0.94) out += `\x1b[200~${pick(random, ["pasted", "line\nline", "\x1b[A inside"])}\x1b[201~`;
		else out += pick(random, ["\x1b", "\x1b[", "\x1b[?6", "\x1b]1"]);
	}
	return out;
}

/** `text` cut at random boundaries (code units: a surrogate pair may be split, as a real read can). */
export function randomChunks(random: () => number, text: string): string[] {
	const chunks: string[] = [];
	let at = 0;
	while (at < text.length) {
		const size = 1 + Math.floor(random() * 12);
		chunks.push(text.slice(at, at + size));
		at += size;
	}
	return chunks;
}

/** Key ids for matching tests: named keys, letters, digits and symbols with modifier combinations. */
export function keyIds(): string[] {
	const keys = [
		"escape",
		"enter",
		"tab",
		"space",
		"backspace",
		"delete",
		"insert",
		"home",
		"end",
		"pageUp",
		"pageDown",
		"up",
		"down",
		"left",
		"right",
		"clear",
		"f1",
		"f5",
		"f12",
		"a",
		"c",
		"d",
		"k",
		"p",
		"z",
		"1",
		"/",
		"-",
		"[",
		"]",
		";",
		"=",
		"+",
		"\\",
		"`",
		"_",
		"?",
	];
	const modifiers = ["", "shift+", "ctrl+", "alt+", "super+", "ctrl+shift+", "ctrl+alt+", "shift+alt+", "ctrl+super+"];
	return keys.flatMap((key) => modifiers.map((modifier) => `${modifier}${key}`));
}
