import { describe, expect, it } from "vitest";
import { parseShellLine, quoteForShell } from "../src/line.ts";

describe("parseShellLine", () => {
	it("finds the command name position", () => {
		expect(parseShellLine("gi")).toMatchObject({ commandPosition: true, current: "gi", currentStart: 0, words: [] });
		expect(parseShellLine("")).toMatchObject({ commandPosition: true, current: "", currentStart: 0 });
	});

	it("splits arguments and keeps the word being typed", () => {
		expect(parseShellLine("git checkout ma")).toMatchObject({
			commandPosition: false,
			words: ["git", "checkout"],
			current: "ma",
			currentStart: 13,
		});
		expect(parseShellLine("git ")).toMatchObject({ words: ["git"], current: "", currentStart: 4 });
	});

	it("starts a new command after separators and substitutions", () => {
		expect(parseShellLine("echo hi | gr")).toMatchObject({ segmentStart: 9, commandPosition: true, current: "gr" });
		expect(parseShellLine("make && npm r")).toMatchObject({ words: ["npm"], current: "r", segmentStart: 7 });
		expect(parseShellLine("a; b")).toMatchObject({ commandPosition: true, current: "b" });
		expect(parseShellLine("echo $(git rev")).toMatchObject({ words: ["git"], current: "rev" });
		expect(parseShellLine('echo "$(gi')).toMatchObject({ commandPosition: true, current: "gi" });
	});

	it("does not split on a redirection to a descriptor", () => {
		expect(parseShellLine("cmd 2>&1 --fl")).toMatchObject({
			segmentStart: 0,
			words: ["cmd", "2>", "1"],
			current: "--fl",
		});
	});

	it("skips leading assignments", () => {
		expect(parseShellLine("FOO=1 BAR=2 np")).toMatchObject({ commandPosition: true, current: "np" });
		expect(parseShellLine("FOO=1 npm ru")).toMatchObject({ words: ["npm"], current: "ru" });
		expect(parseShellLine("FOO=")).toMatchObject({ commandPosition: false });
	});

	it("reads quotes and escapes", () => {
		expect(parseShellLine("cat 'my fi")).toMatchObject({ current: "'my fi", currentValue: "my fi", openQuote: "'" });
		expect(parseShellLine('cat "a b" c')).toMatchObject({ words: ["cat", "a b"], current: "c" });
		expect(parseShellLine("cat my\\ fi")).toMatchObject({ current: "my\\ fi", currentValue: "my fi", currentStart: 4 });
		expect(parseShellLine('echo "a | b" | wc -')).toMatchObject({ words: ["wc"], current: "-" });
	});
});

describe("quoteForShell", () => {
	it("leaves safe words alone and escapes the rest", () => {
		expect(quoteForShell("src/index.ts")).toBe("src/index.ts");
		expect(quoteForShell("my file")).toBe("my\\ file");
		expect(quoteForShell("a$b")).toBe("a\\$b");
		expect(quoteForShell("~/my dir")).toBe("~/my\\ dir");
	});

	it("writes inside an open quote", () => {
		expect(quoteForShell("my file", "'")).toBe("'my file'");
		expect(quoteForShell("it's", "'")).toBe("'it'\\''s'");
		expect(quoteForShell('say "hi"', '"')).toBe('"say \\"hi\\""');
		expect(quoteForShell("my dir", '"', true)).toBe('"my dir');
	});
});
