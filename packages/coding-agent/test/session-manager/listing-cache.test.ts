import { appendFileSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { listSessionHeaders } from "../../src/core/session-manager/header-listing.ts";
import { buildSessionInfo } from "../../src/core/session-manager/listing.ts";
import {
	clearListedSessionInfos,
	listedSessionInfo,
	listedSessionInfoUsage,
} from "../../src/core/session-manager/listing-cache.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "octocode-listing-cache-"));
	clearListedSessionInfos();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** `count` sessions of a few messages each, in one folder. */
function sessions(count: number): string[] {
	const files: string[] = [];
	for (let n = 0; n < count; n++) {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: `task ${n}: café`, timestamp: 1_000 + n });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `done ${n}` }],
			timestamp: 2_000 + n,
		} as never);
		if (n % 2) manager.appendSessionInfo(`name ${n}`);
		files.push(manager.getSessionFile()!);
	}
	return files;
}

/** Every file parsed again, as the listing did before it kept parses. */
async function parsedEach(files: readonly string[]) {
	const infos = await Promise.all(files.map((file) => buildSessionInfo(file)));
	return infos.flatMap((info) => (info ? [info] : [])).sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

describe("session listings", () => {
	it("equal a parse of every file, reuse unchanged parses and parse a changed file again", async () => {
		const files = sessions(6);
		const first = await SessionManager.list(dir, dir);
		expect(first).toEqual(await parsedEach(files));
		const again = await SessionManager.list(dir, dir);
		expect(again).toEqual(first);
		// Each listing gets its own rows.
		again[0].name = "changed by a caller";
		again[0].created.setTime(0);
		again[0].modified.setTime(0);
		expect((await SessionManager.list(dir, dir))[0].name).not.toBe("changed by a caller");
		expect(await SessionManager.list(dir, dir)).toEqual(first);

		// A turn appended to one file: that file is read again, with its new message, and the rest are unchanged.
		const manager = SessionManager.open(files[2]);
		manager.appendMessage({ role: "user", content: "one more", timestamp: 9_000 });
		const after = await SessionManager.list(dir, dir);
		expect(after).toEqual(await parsedEach(files));
		expect(after.find((info) => info.path === files[2])?.messageCount).toBe(3);
		expect(await SessionManager.listAll(dir)).toEqual(await parsedEach(files));
	});

	it("parse a file again when only its contents changed, at the same size", async () => {
		const parses: string[] = [];
		const file = join(dir, "s.jsonl");
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "s",
			cwd: dir,
			timestamp: "2026-01-01T00:00:00Z",
		});
		writeFileSync(file, `${header}\n`);
		const list = () =>
			listedSessionInfo(file, (stats) => {
				parses.push(file);
				return buildSessionInfo(file, undefined, stats);
			});
		await list();
		await list();
		expect(parses).toHaveLength(1);
		const size = statSync(file).size;
		writeFileSync(file, `${header.replace('"s"', '"t"')}\n`);
		expect(statSync(file).size).toBe(size);
		expect((await list())?.id).toBe("t");
		expect(parses).toHaveLength(2);
		appendFileSync(file, "\n");
		await list();
		expect(parses).toHaveLength(3);
	});

	it("find ids and folders by header alone, as the full listing lists them", async () => {
		const files = sessions(3);
		const other = mkdtempSync(join(tmpdir(), "octocode-listing-other-"));
		try {
			const elsewhere = SessionManager.create(other, dir);
			elsewhere.appendMessage({ role: "user", content: "elsewhere", timestamp: 5 });
			const byHeader = (list: readonly { path: string; id: string; cwd: string }[]) =>
				list.map(({ path, id, cwd }) => ({ path, id, cwd })).sort((a, b) => a.path.localeCompare(b.path));
			expect(byHeader(await listSessionHeaders(dir, dir))).toEqual(byHeader(await SessionManager.list(dir, dir)));
			expect(byHeader(await listSessionHeaders(undefined, dir))).toEqual(byHeader(await SessionManager.listAll(dir)));
			expect((await listSessionHeaders(dir, dir)).map((info) => info.path).sort()).toEqual([...files].sort());
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	describe("budget", () => {
		/** A listing of `text.length` characters, parsed after the caller lets it finish. */
		const info = (path: string, text: string) =>
			({
				path,
				id: "s",
				cwd: dir,
				created: new Date(0),
				modified: new Date(0),
				messageCount: 1,
				firstMessage: "",
				allMessagesText: text,
			}) as never;
		const file = (name: string) => {
			const path = join(dir, name);
			writeFileSync(path, "x");
			return path;
		};

		it("parses a file once for listings that ask at the same time, and counts it once", async () => {
			const path = file("a.jsonl");
			const text = "y".repeat(1_000_000);
			let parses = 0;
			const parse = async () => {
				parses++;
				await new Promise((resolve) => setImmediate(resolve));
				return info(path, text);
			};
			const listed = await Promise.all([1, 2, 3, 4].map(() => listedSessionInfo(path, parse)));
			expect(parses).toBe(1);
			// Each caller its own copy.
			expect(new Set(listed).size).toBe(4);
			const once = listedSessionInfoUsage();
			expect(once.entries).toBe(1);
			expect(once.size).toBeGreaterThanOrEqual(text.length);
			expect(once.size).toBeLessThan(2 * text.length);

			// A changed file replaces its entry: the count does not grow with the times it changed.
			for (let change = 0; change < 5; change++) {
				appendFileSync(path, "x");
				await Promise.all([1, 2].map(() => listedSessionInfo(path, parse)));
			}
			expect(listedSessionInfoUsage()).toEqual(once);
		});

		it("forgets a file that is gone, and keeps another file within the budget after concurrent listings", async () => {
			const big = "y".repeat(10 * 1024 * 1024);
			const a = file("a.jsonl");
			const parse = (path: string) => async () => {
				await new Promise((resolve) => setImmediate(resolve));
				return info(path, big);
			};
			await Promise.all([1, 2, 3, 4].map(() => listedSessionInfo(a, parse(a))));
			const b = file("b.jsonl");
			let parses = 0;
			const counted = async () => {
				parses++;
				return parse(b)();
			};
			await listedSessionInfo(b, counted);
			await listedSessionInfo(b, counted);
			expect(parses).toBe(1);
			expect(listedSessionInfoUsage().entries).toBe(2);

			unlinkSync(a);
			await listedSessionInfo(a, async () => null);
			expect(listedSessionInfoUsage().entries).toBe(1);
		});

		it("lets a listing parse itself when the parse it waited for fails", async () => {
			const path = file("a.jsonl");
			const failing = async () => {
				await new Promise((resolve) => setImmediate(resolve));
				throw new Error("aborted");
			};
			// The same stats for both, so the first parse is running when the second listing asks.
			const stats = statSync(path);
			const first = listedSessionInfo(path, failing, stats);
			const second = listedSessionInfo(path, async () => info(path, "own"), stats);
			await expect(first).rejects.toThrow("aborted");
			expect((await second)?.allMessagesText).toBe("own");
		});
	});
});
