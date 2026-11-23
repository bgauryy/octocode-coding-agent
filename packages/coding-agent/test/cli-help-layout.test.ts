import { expect, it, vi } from "vitest";
import { printHelp } from "../src/cli/args.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const helpText = (): string => {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		printHelp();
		return stripAnsi(log.mock.calls.map((call) => String(call[0])).join("\n"));
	} finally {
		log.mockRestore();
	}
};

/** The rows of the section under `heading`, up to the next blank line. */
const section = (text: string, heading: string): string[] => {
	const lines = text.split("\n");
	const start = lines.indexOf(heading) + 1;
	const end = lines.indexOf("", start);
	return lines.slice(start, end);
};

it("never runs a flag or command into its text: a long one puts the text on the next row", () => {
	const text = helpText();
	expect(text).toMatch(/^ {2}--model-size <small\|medium\|large>\n {33}List models/m);
	expect(text).toMatch(/^ {2}octocode security <list\|check\|approve\|deny>\n {37}Review/m);
	// A usage that ends in `>` or `]` glued to its text (`<small|medium|large>List`) is the bug this guards.
	for (const row of [...section(text, "Options:"), ...section(text, "Commands:")])
		expect(row).not.toMatch(/[>\]][A-Z]/);
});

it("starts every environment variable's and tool's text in one column", () => {
	const text = helpText();
	for (const heading of ["Environment Variables:", "Built-in Tool Names:"]) {
		const columns = new Set(section(text, heading).map((row) => row.indexOf(" - ")));
		expect(columns.size, heading).toBe(1);
	}
});
