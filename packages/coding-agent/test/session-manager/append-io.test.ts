import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { withSessionFileLock } from "../../src/core/session-manager/shared-file.ts";
import { userMsg } from "../utilities.ts";

/** Synchronous file system calls by name and first argument, counted while `counting` is set. */
const { calls, state } = vi.hoisted(() => ({
	calls: [] as { name: string; target: string }[],
	state: { counting: false },
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof realFs>();
	const counted = (name: string) => {
		const fn = (actual as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
		return Object.assign((...args: unknown[]) => {
			if (state.counting) calls.push({ name, target: String(args[0]) });
			return fn(...args);
		}, fn);
	};
	const names = ["statSync", "fstatSync", "readFileSync", "writeFileSync", "rmSync", "mkdirSync"];
	const wrapped = Object.fromEntries(names.map((name) => [name, counted(name)]));
	return { ...actual, ...wrapped, default: { ...actual, ...wrapped } };
});

let dir: string;
beforeEach(() => {
	dir = realFs.mkdtempSync(join(tmpdir(), "session-append-io-"));
});
afterEach(() => {
	state.counting = false;
	calls.length = 0;
	realFs.rmSync(dir, { recursive: true, force: true });
});

describe("a steady-state session append", () => {
	it("reads the session file's size once before and once after, never reads its lock owner back, and creates no folder", () => {
		const session = SessionManager.create(dir, dir);
		for (let i = 0; i < 3; i++) session.appendMessage(userMsg(`warm ${i}`));
		const file = session.getSessionFile()!;

		state.counting = true;
		session.appendMessage(userMsg("steady"));
		state.counting = false;

		const onFile = calls.filter(({ name, target }) => name === "statSync" && target === file);
		// The tail read's fstat stands in for the size before; the stamp after the last record is the only stat by path.
		expect(onFile.length).toBeLessThanOrEqual(1);
		expect(calls.filter(({ name }) => name === "fstatSync").length).toBeLessThanOrEqual(1);
		const owner = calls.filter(({ target }) => target.endsWith(".lock.owner"));
		expect(owner.filter(({ name }) => name === "readFileSync")).toEqual([]);
		expect(calls.filter(({ name, target }) => name === "mkdirSync" && target === dirname(file))).toEqual([]);
		expect(realFs.existsSync(`${file}.lock.owner`)).toBe(false);
		expect(realFs.existsSync(`${file}.lock`)).toBe(false);
		expect(realFs.readFileSync(file, "utf8")).toContain("steady");
	});

	it("still creates a missing session folder when it takes the lock", () => {
		const file = join(dir, "a", "b", "session.jsonl");
		expect(withSessionFileLock(file, () => realFs.existsSync(`${file}.lock`))).toBe(true);
		expect(realFs.statSync(dirname(file)).isDirectory()).toBe(true);
		expect(realFs.existsSync(`${file}.lock`)).toBe(false);
	});
});
