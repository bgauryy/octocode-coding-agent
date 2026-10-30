/**
 * A QR encoder for links printed in the terminal: byte mode, error-correction level M, versions 1 to 40, the mask
 * with the lowest penalty. Nothing else is needed, so nothing else is here. Rendering uses half-block characters, two
 * module rows per text line, with a quiet zone the phone's camera needs.
 */

const EC_LEVEL_M = 0b00;
/** Error-correction codewords per block and blocks (group 1 count, group 1 data words, group 2 count) for level M, by version. */
const EC_M: Array<[number, number, number, number]> = [
	[10, 1, 16, 0],
	[16, 1, 28, 0],
	[26, 1, 44, 0],
	[18, 2, 32, 0],
	[24, 2, 43, 0],
	[16, 4, 27, 0],
	[18, 4, 31, 0],
	[22, 2, 38, 2],
	[22, 3, 36, 2],
	[26, 4, 43, 1],
	[30, 1, 50, 4],
	[22, 6, 36, 2],
	[22, 8, 37, 1],
	[24, 4, 40, 5],
	[24, 5, 41, 5],
	[28, 7, 45, 3],
	[28, 10, 46, 1],
	[26, 9, 43, 4],
	[26, 3, 44, 11],
	[26, 3, 41, 13],
	[26, 17, 42, 0],
	[28, 17, 46, 0],
	[28, 4, 47, 14],
	[28, 6, 45, 14],
	[28, 8, 47, 13],
	[28, 19, 46, 4],
	[28, 22, 45, 3],
	[28, 3, 45, 23],
	[28, 21, 45, 7],
	[28, 19, 47, 10],
	[28, 2, 46, 29],
	[28, 10, 46, 23],
	[28, 14, 46, 21],
	[28, 14, 46, 23],
	[28, 12, 47, 26],
	[28, 6, 47, 34],
	[28, 29, 46, 14],
	[28, 13, 46, 32],
	[28, 40, 47, 7],
	[28, 18, 47, 31],
];
const ALIGNMENT: number[][] = [
	[],
	[6, 18],
	[6, 22],
	[6, 26],
	[6, 30],
	[6, 34],
	[6, 22, 38],
	[6, 24, 42],
	[6, 26, 46],
	[6, 28, 50],
	[6, 30, 54],
	[6, 32, 58],
	[6, 34, 62],
	[6, 26, 46, 66],
	[6, 26, 48, 70],
	[6, 26, 50, 74],
	[6, 30, 54, 78],
	[6, 30, 56, 82],
	[6, 30, 58, 86],
	[6, 34, 62, 90],
	[6, 28, 50, 72, 94],
	[6, 26, 50, 74, 98],
	[6, 30, 54, 78, 102],
	[6, 28, 54, 80, 106],
	[6, 32, 58, 84, 110],
	[6, 30, 58, 86, 114],
	[6, 34, 62, 90, 118],
	[6, 26, 50, 74, 98, 122],
	[6, 30, 54, 78, 102, 126],
	[6, 26, 52, 78, 104, 130],
	[6, 30, 56, 82, 108, 134],
	[6, 34, 60, 86, 112, 138],
	[6, 30, 58, 86, 114, 142],
	[6, 34, 62, 90, 118, 146],
	[6, 30, 54, 78, 102, 126, 150],
	[6, 24, 50, 76, 102, 128, 154],
	[6, 28, 54, 80, 106, 132, 158],
	[6, 32, 58, 84, 110, 136, 162],
	[6, 26, 54, 82, 110, 138, 166],
	[6, 30, 58, 86, 114, 142, 170],
];

// GF(256) with the QR polynomial 0x11d.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
	EXP[i] = x;
	LOG[x] = i;
	x <<= 1;
	if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generator(degree: number): Uint8Array {
	let poly = Uint8Array.of(1);
	for (let i = 0; i < degree; i++) {
		const next = new Uint8Array(poly.length + 1);
		for (let j = 0; j < poly.length; j++) {
			next[j] ^= poly[j];
			next[j + 1] ^= mul(poly[j], EXP[i]);
		}
		poly = next;
	}
	return poly;
}

/** Reed-Solomon error-correction codewords for one block. */
export function errorCorrection(data: Uint8Array, degree: number): Uint8Array {
	const gen = generator(degree);
	const result = new Uint8Array(degree);
	for (const byte of data) {
		const factor = byte ^ result[0];
		result.copyWithin(0, 1);
		result[degree - 1] = 0;
		for (let i = 0; i < degree; i++) result[i] ^= mul(gen[i + 1], factor);
	}
	return result;
}

const totalDataWords = (version: number): number => {
	const [, g1, g1Words, g2] = EC_M[version - 1];
	return g1 * g1Words + g2 * (g1Words + 1);
};

function smallestVersion(bytes: number): number {
	for (let version = 1; version <= 40; version++) {
		const header = 4 + (version < 10 ? 8 : 16);
		if (Math.ceil((header + bytes * 8) / 8) <= totalDataWords(version)) return version;
	}
	throw new Error("Too long for a QR code.");
}

function dataCodewords(bytes: Uint8Array, version: number): Uint8Array {
	const bits: number[] = [];
	const put = (value: number, length: number) => {
		for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
	};
	put(0b0100, 4);
	put(bytes.length, version < 10 ? 8 : 16);
	for (const byte of bytes) put(byte, 8);
	const capacity = totalDataWords(version) * 8;
	put(0, Math.min(4, capacity - bits.length));
	while (bits.length % 8) bits.push(0);
	const words = new Uint8Array(capacity / 8);
	for (let i = 0; i < bits.length; i += 8) {
		let word = 0;
		for (let j = 0; j < 8; j++) word = (word << 1) | bits[i + j];
		words[i / 8] = word;
	}
	for (let i = bits.length / 8, pad = 0xec; i < words.length; i++, pad ^= 0xec ^ 0x11) words[i] = pad;
	return words;
}

/** Data and error-correction blocks interleaved as the symbol stores them. */
function interleave(data: Uint8Array, version: number): Uint8Array {
	const [ec, g1, g1Words, g2] = EC_M[version - 1];
	const blocks: Uint8Array[] = [];
	const ecBlocks: Uint8Array[] = [];
	let offset = 0;
	for (let i = 0; i < g1 + g2; i++) {
		const size = i < g1 ? g1Words : g1Words + 1;
		const block = data.subarray(offset, offset + size);
		offset += size;
		blocks.push(block);
		ecBlocks.push(errorCorrection(block, ec));
	}
	const out: number[] = [];
	const longest = g2 ? g1Words + 1 : g1Words;
	for (let i = 0; i < longest; i++) for (const block of blocks) if (i < block.length) out.push(block[i]);
	for (let i = 0; i < ec; i++) for (const block of ecBlocks) out.push(block[i]);
	return Uint8Array.from(out);
}

type Matrix = { size: number; modules: Uint8Array; reserved: Uint8Array };

function matrix(version: number): Matrix {
	const size = version * 4 + 17;
	return { size, modules: new Uint8Array(size * size), reserved: new Uint8Array(size * size) };
}

function set(m: Matrix, x: number, y: number, dark: boolean, reserve = true): void {
	m.modules[y * m.size + x] = dark ? 1 : 0;
	if (reserve) m.reserved[y * m.size + x] = 1;
}

function placeFinder(m: Matrix, left: number, top: number): void {
	for (let y = -1; y <= 7; y++)
		for (let x = -1; x <= 7; x++) {
			const px = left + x;
			const py = top + y;
			if (px < 0 || py < 0 || px >= m.size || py >= m.size) continue;
			const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
			set(m, px, py, ring !== 2 && ring !== 4 && x >= 0 && y >= 0 && x <= 6 && y <= 6);
		}
}

function placePatterns(m: Matrix, version: number): void {
	placeFinder(m, 0, 0);
	placeFinder(m, m.size - 7, 0);
	placeFinder(m, 0, m.size - 7);
	for (let i = 8; i < m.size - 8; i++) {
		set(m, i, 6, i % 2 === 0);
		set(m, 6, i, i % 2 === 0);
	}
	const centers = ALIGNMENT[version - 1];
	for (const cy of centers)
		for (const cx of centers) {
			if (m.reserved[cy * m.size + cx]) continue;
			for (let y = -2; y <= 2; y++)
				for (let x = -2; x <= 2; x++) set(m, cx + x, cy + y, Math.max(Math.abs(x), Math.abs(y)) !== 1);
		}
	// Format areas (filled later) and the dark module.
	for (let i = 0; i < 9; i++) {
		if (i !== 6) {
			set(m, i, 8, false);
			set(m, 8, i, false);
		}
		if (i < 8) {
			set(m, m.size - 1 - i, 8, false);
			set(m, 8, m.size - 1 - i, false);
		}
	}
	set(m, 8, m.size - 8, true);
	if (version >= 7) {
		let info = version << 12;
		for (let i = 5; i >= 0; i--) if (info & (1 << (i + 12))) info ^= 0x1f25 << i;
		info |= version << 12;
		for (let i = 0; i < 18; i++) {
			const dark = ((info >> i) & 1) === 1;
			set(m, Math.floor(i / 3), m.size - 11 + (i % 3), dark);
			set(m, m.size - 11 + (i % 3), Math.floor(i / 3), dark);
		}
	}
}

const MASKS: Array<(x: number, y: number) => boolean> = [
	(x, y) => (x + y) % 2 === 0,
	(_x, y) => y % 2 === 0,
	(x) => x % 3 === 0,
	(x, y) => (x + y) % 3 === 0,
	(x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
	(x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
	(x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
	(x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function placeData(m: Matrix, words: Uint8Array, mask: number): void {
	let bit = 0;
	const total = words.length * 8;
	let up = true;
	for (let right = m.size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let step = 0; step < m.size; step++) {
			const y = up ? m.size - 1 - step : step;
			for (const x of [right, right - 1]) {
				if (m.reserved[y * m.size + x]) continue;
				let dark = false;
				if (bit < total) {
					dark = ((words[bit >> 3] >> (7 - (bit & 7))) & 1) === 1;
					bit++;
				}
				if (MASKS[mask](x, y)) dark = !dark;
				set(m, x, y, dark, false);
			}
		}
		up = !up;
	}
}

function placeFormat(m: Matrix, mask: number): void {
	let format = (EC_LEVEL_M << 3) | mask;
	let bits = format << 10;
	for (let i = 4; i >= 0; i--) if (bits & (1 << (i + 10))) bits ^= 0x537 << i;
	format = ((format << 10) | bits) ^ 0x5412;
	for (let i = 0; i < 15; i++) {
		const dark = ((format >> i) & 1) === 1;
		if (i < 6) set(m, 8, i, dark);
		else if (i < 8) set(m, 8, i + 1, dark);
		else set(m, 8, m.size - 15 + i, dark);
		if (i < 8) set(m, m.size - 1 - i, 8, dark);
		else if (i < 9) set(m, 7, 8, dark);
		else set(m, 14 - i, 8, dark);
	}
}

/** The symbol's penalty score (ISO 18004 §7.8.3): the mask with the lowest wins. */
function penalty(m: Matrix): number {
	const at = (x: number, y: number) => m.modules[y * m.size + x];
	let score = 0;
	for (let pass = 0; pass < 2; pass++)
		for (let a = 0; a < m.size; a++) {
			let run = 0;
			let last = -1;
			for (let b = 0; b < m.size; b++) {
				const value = pass ? at(a, b) : at(b, a);
				if (value === last) run++;
				else {
					if (run >= 5) score += run - 2;
					run = 1;
					last = value;
				}
			}
			if (run >= 5) score += run - 2;
		}
	for (let y = 0; y < m.size - 1; y++)
		for (let x = 0; x < m.size - 1; x++) {
			const v = at(x, y);
			if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
		}
	const pattern = [1, 0, 1, 1, 1, 0, 1];
	for (let pass = 0; pass < 2; pass++)
		for (let a = 0; a < m.size; a++)
			for (let b = 0; b + 10 < m.size + 1; b++) {
				const read = (i: number) => (pass ? at(a, b + i) : at(b + i, a));
				const matches = (offset: number) => pattern.every((p, i) => read(offset + i) === p);
				const light = (from: number) => [0, 1, 2, 3].every((i) => b + from + i < m.size && read(from + i) === 0);
				if ((matches(0) && light(7)) || (matches(4) && light(0))) score += 40;
			}
	let dark = 0;
	for (const module of m.modules) dark += module;
	score += Math.floor(Math.abs((dark * 100) / m.modules.length - 50) / 5) * 10;
	return score;
}

/** The modules of a QR symbol for `text`, true for dark, as rows. */
export function qrModules(text: string): boolean[][] {
	const bytes = new TextEncoder().encode(text);
	const version = smallestVersion(bytes.length);
	const words = interleave(dataCodewords(bytes, version), version);
	let best: Matrix | undefined;
	let bestScore = Infinity;
	for (let mask = 0; mask < 8; mask++) {
		const m = matrix(version);
		placePatterns(m, version);
		placeData(m, words, mask);
		placeFormat(m, mask);
		const score = penalty(m);
		if (score < bestScore) {
			bestScore = score;
			best = m;
		}
	}
	const m = best!;
	return Array.from({ length: m.size }, (_, y) =>
		Array.from({ length: m.size }, (_, x) => m.modules[y * m.size + x] === 1),
	);
}

/** The symbol as text: two module rows per line with half blocks, a two-module quiet zone, dark drawn as block. */
export function qrText(text: string): string {
	const modules = qrModules(text);
	const quiet = 2;
	const size = modules.length + quiet * 2;
	const at = (x: number, y: number) => {
		const mx = x - quiet;
		const my = y - quiet;
		return my >= 0 && my < modules.length && mx >= 0 && mx < modules.length ? modules[my][mx] : false;
	};
	const lines: string[] = [];
	for (let y = 0; y < size; y += 2) {
		let line = "";
		for (let x = 0; x < size; x++) {
			const top = at(x, y);
			const bottom = y + 1 < size ? at(x, y + 1) : false;
			line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
		}
		lines.push(line);
	}
	return lines.join("\n");
}
