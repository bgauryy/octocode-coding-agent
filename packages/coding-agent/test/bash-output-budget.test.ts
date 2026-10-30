import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASH_MAX_BYTES, BASH_MAX_LINES, bashBudget } from "../src/core/tools/bash/budget.ts";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";

const text = (result: any): string => result.content.map((part: any) => part.text).join("\n");

function chatty(lines: (index: number) => string, count: number, exitCode = 0): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			for (let i = 1; i <= count; i++) onData(Buffer.from(`${lines(i)}\n`, "utf-8"));
			return { exitCode };
		},
	};
}

describe("bashBudget", () => {
	it("defaults to 24 KB and 600 lines", () => {
		expect(BASH_MAX_BYTES).toBe(24 * 1024);
		expect(BASH_MAX_LINES).toBe(600);
		expect(bashBudget()).toEqual({ maxBytes: 24 * 1024, maxLines: 600 });
	});

	it("scales the line limit with the byte setting", () => {
		expect(bashBudget(48 * 1024)).toEqual({ maxBytes: 48 * 1024, maxLines: 1200 });
		expect(bashBudget(2048).maxLines).toBe(50);
	});

	it("lowers the budget with maxOutputTokens at about 4 bytes a token, between 100 tokens and the setting", () => {
		expect(bashBudget(undefined, 1000)).toEqual({ maxBytes: 4000, maxLines: 98 });
		expect(bashBudget(undefined, 5).maxBytes).toBe(400);
		expect(bashBudget(undefined, 1_000_000).maxBytes).toBe(24 * 1024);
		expect(bashBudget(8 * 1024, 1_000_000).maxBytes).toBe(8 * 1024);
		expect(bashBudget(undefined, Number.NaN).maxBytes).toBe(24 * 1024);
	});
});

describe("bash result header and budget", () => {
	let dir: string;
	beforeEach(() => {
		dir = join(tmpdir(), `bash-budget-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(dir, { recursive: true });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("starts a successful result with exit, time, lines and size, and reports totals in structured content", async () => {
		const bash = createBashTool(dir, { operations: chatty((i) => `row ${i}`, 312) });
		const result = await bash.execute("c1", { command: "x" });
		expect(text(result).split("\n")[0]).toMatch(/^\[exit 0 · [\d.]+s · 312 lines · 2 KB\]$/);
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({ exit_code: 0, total_lines: 312, total_bytes: 2388 });
	});

	it("keeps isError for a non-zero exit and drops the old status footer", async () => {
		const bash = createBashTool(dir, { operations: chatty(() => "boom", 1, 2) });
		const result = await bash.execute("c2", { command: "x" });
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("[exit 2 · 0s · 1 line · 5 B]\nboom\n");
	});

	it("uses the same header for a timeout and an abort", async () => {
		for (const [error, header] of [
			["timeout:900", /^\[timed out after 900s · 1 line · 3 B\]\nhi\n/],
			["aborted", /^\[aborted · [\d.]+s · 1 line · 3 B\]\nhi\n/],
		] as const) {
			const bash = createBashTool(dir, {
				operations: {
					exec: async (_command, _cwd, { onData }) => {
						onData(Buffer.from("hi\n"));
						throw new Error(error);
					},
				},
			});
			await expect(bash.execute("c3", { command: "x" })).rejects.toThrow(header);
		}
	});

	it("trims a 50k-line failing build to a 20/80 head and tail with the middle error, and names the saved file", async () => {
		const bash = createBashTool(dir, {
			operations: chatty(
				(i) => (i === 25_000 ? "src/x.ts(1,1): error TS2322: bad type" : `compiling module ${i}`),
				50_000,
				1,
			),
		});
		const result = await bash.execute("c4", { command: "x" });
		const body = text(result);
		const [header, ...rest] = body.split("\n");
		const file = result.details?.fullOutputPath as string;
		expect(header).toMatch(
			/^\[exit 1 · [\d.]+s · 50,000 lines · \d+(\.\d)? (KB|MB) · trimmed: first 120 \+ last 47\d lines \+ 1 matched · full output: /,
		);
		expect(header.endsWith(`full output: ${file}]`)).toBe(true);
		expect(rest[0]).toBe("compiling module 1");
		expect(body).toContain("\n  25000: src/x.ts(1,1): error TS2322: bad type\n");
		expect(body).toContain("1 matched line below, then the end of the output]");
		expect(body.endsWith("compiling module 50000")).toBe(true);
		expect(Buffer.byteLength(body)).toBeLessThan(BASH_MAX_BYTES + 400);
		expect(existsSync(file)).toBe(true);
		expect(readFileSync(file, "utf8").split("\n")[24_999]).toContain("error TS2322");
		expect(result.structuredContent).toMatchObject({ total_lines: 50_000, exit_code: 1 });
		rmSync(file, { force: true });
	});

	it("lowers the budget for a call with maxOutputTokens", async () => {
		const bash = createBashTool(dir, { operations: chatty((i) => `line ${String(i).padStart(4, "0")}`, 2000) });
		const result = await bash.execute("c5", { command: "x", maxOutputTokens: 200 });
		const body = text(result);
		expect(Buffer.byteLength(body.split("\n").slice(1).join("\n"))).toBeLessThanOrEqual(800 + 100);
		expect(body.split("\n")[0]).toMatch(/trimmed: first 4 \+ last \d+ lines/);
		rmSync(result.details?.fullOutputPath as string, { force: true });
	});

	it("says `last 1 line` when only the final line of a very long one fits", async () => {
		const bash = createBashTool(dir, {
			operations: chatty((i) => (i === 1 ? "x".repeat(100_000) : "tail"), 2),
		});
		const result = await bash.execute("c7", { command: "x" });
		expect(text(result).split("\n")[0]).toMatch(/trimmed: last 1 line · full output: /);
		rmSync(result.details?.fullOutputPath as string, { force: true });
	});

	it("takes the byte budget from maxOutputBytes", async () => {
		const bash = createBashTool(dir, { operations: chatty((i) => `line ${i}`, 1000), maxOutputBytes: 2048 });
		const result = await bash.execute("c6", { command: "x" });
		expect(result.details?.truncation).toMatchObject({ truncated: true, maxBytes: 2048, maxLines: 50 });
		rmSync(result.details?.fullOutputPath as string, { force: true });
	});
});
