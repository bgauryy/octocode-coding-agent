import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FileEntry, SessionManager } from "../../src/core/session-manager.ts";
import { lockSessionFile } from "../../src/core/session-manager/shared-file.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

let dir: string;
let session: SessionManager;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-held-lock-"));
	session = SessionManager.create(dir, dir);
	session.appendMessage(userMsg("hello"));
	session.appendMessage(assistantMsg("hi"));
	file = session.getSessionFile()!;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const texts = (): string[] =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as FileEntry)
		.flatMap((entry) => (entry.type === "message" ? [JSON.stringify(entry.message)] : []));
const written = (text: string) => texts().some((content) => content.includes(text));
const until = async (done: () => boolean, ms: number) => {
	const deadline = Date.now() + ms;
	while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
};

describe("a session record while another writer holds the session lock", () => {
	for (const initial of [false, true]) {
		it(`never sleeps on the event loop for a held ${initial ? "initial" : "existing"} append`, async () => {
			if (initial) {
				session = SessionManager.create(dir, dir);
				file = session.getSessionFile()!;
				expect(existsSync(file)).toBe(false);
			}
			const release = lockSessionFile(file);
			const wait = vi.spyOn(Atomics, "wait");
			try {
				const id = session.appendMessage(userMsg("no blocking wait"));
				expect(session.getEntry(id)).toBeDefined();
				expect(wait).not.toHaveBeenCalled();
			} finally {
				wait.mockRestore();
				release();
			}
			await until(() => existsSync(file) && written("no blocking wait"), 5_000);
			expect(written("no blocking wait")).toBe(true);
		});
	}
	it("keeps a reply in memory after a short wait instead of holding the thread for seconds", () => {
		const release = lockSessionFile(file);
		try {
			const startedAt = Date.now();
			const id = session.appendMessage(assistantMsg("held reply"));
			expect(Date.now() - startedAt).toBeLessThan(1_000);
			// The record is part of the session at once; only its write waits.
			expect(session.getEntry(id)).toBeDefined();
			expect(written("held reply")).toBe(false);
		} finally {
			release();
		}
	});

	it("writes held records, in order and once each, when the lock is free, without another record arriving", async () => {
		const release = lockSessionFile(file);
		session.appendMessage(assistantMsg("first held"));
		session.appendMessage(assistantMsg("second held"));
		expect(written("first held")).toBe(false);
		release();
		await until(() => written("second held"), 5_000);
		const order = texts().filter((content) => content.includes("held"));
		expect(order).toHaveLength(2);
		expect(order[0]).toContain("first held");
		expect(order[1]).toContain("second held");
	});

	it("still writes held records first when the next record arrives before the retry", () => {
		const release = lockSessionFile(file);
		session.appendMessage(assistantMsg("held before"));
		release();
		session.appendMessage(assistantMsg("written after"));
		const order = texts().filter((content) => content.includes("held before") || content.includes("written after"));
		expect(order).toHaveLength(2);
		expect(order[0]).toContain("held before");
	});

	it("holds every record kind the same way: a user message and a custom entry are kept and written, never refused", async () => {
		const release = lockSessionFile(file);
		const startedAt = Date.now();
		session.appendMessage(userMsg("held question"));
		session.appendCustomEntry("held-note", { value: 1 });
		expect(Date.now() - startedAt).toBeLessThan(1_500);
		release();
		const raw = () => readFileSync(file, "utf8");
		await until(() => raw().includes("held-note"), 5_000);
		expect(raw()).toContain("held question");
		expect(raw().indexOf("held question")).toBeLessThan(raw().indexOf("held-note"));
	});
});
