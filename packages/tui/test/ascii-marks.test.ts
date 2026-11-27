import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { isAsciiLocale } from "../src/tokens/charset.ts";

const probe = `
import { GLYPH, LIGHT_GLYPH, SPINNER, TONE, titleMark } from "./src/tokens/design.ts";
console.log(JSON.stringify([...SPINNER.braille, ...Object.values(GLYPH), ...Object.values(LIGHT_GLYPH), TONE.calm, TONE.caution, TONE.problem, titleMark()]));
`;

function marks(env: Record<string, string>): string[] {
	const base = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
	const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
		cwd: new URL("..", import.meta.url),
		env: { ...base, ...env },
		encoding: "utf8",
	});
	return JSON.parse(out) as string[];
}

describe("ASCII marks off UTF-8", () => {
	it("uses only ASCII under LC_ALL=C, and keeps every state's mark distinct", () => {
		const list = marks({ LC_ALL: "C" });
		assert.ok(list.length > 20);
		for (const mark of list) assert.match(mark, /^[\x20-\x7e]+$/);
		const light = marks({ LC_ALL: "C" }).slice(4 + 18, 4 + 18 + 6);
		assert.strictEqual(new Set(light).size, 6);
	});

	it("keeps the glyphs under en_US.UTF-8", () => {
		const list = marks({ LC_ALL: "en_US.UTF-8" });
		assert.ok(list.some((mark) => /[^\x20-\x7e]/.test(mark)));
		assert.strictEqual(list[0], "\u280b");
	});

	it("reads LC_ALL, then LC_CTYPE, then LANG, first non-empty", () => {
		assert.strictEqual(isAsciiLocale({ LC_ALL: "C", LANG: "en_US.UTF-8" }, "linux"), true);
		assert.strictEqual(isAsciiLocale({ LC_ALL: "", LC_CTYPE: "de_DE.utf8", LANG: "C" }, "linux"), false);
		assert.strictEqual(isAsciiLocale({ LANG: "POSIX" }, "darwin"), true);
		assert.strictEqual(isAsciiLocale({}, "darwin"), false);
		assert.strictEqual(isAsciiLocale({}, "win32"), false);
		assert.strictEqual(isAsciiLocale({}, "linux"), false);
	});
});
