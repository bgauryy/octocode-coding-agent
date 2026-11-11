import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FileEntry, SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-rewrite-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Internals {
	state: { fileEntries: FileEntry[] };
	_rewriteFile(): void;
}

/** A session on disk whose last entry runs `onSerialize` each time it is serialized. */
function session(onSerialize: (file: string) => void) {
	const manager = SessionManager.create(dir, dir);
	manager.appendMessage(userMsg("hello"));
	manager.appendMessage(assistantMsg("hi"));
	const id = manager.appendCustomEntry("probe", 1);
	const file = manager.getSessionFile()!;
	const internals = manager as unknown as Internals;
	const probe = internals.state.fileEntries.find((entry) => "id" in entry && entry.id === id)!;
	Object.defineProperty(probe, "toJSON", {
		enumerable: false,
		value() {
			onSerialize(file);
			return { ...this };
		},
	});
	return { manager, internals, file };
}
const lines = (file: string) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { id?: string });

describe("session file rewrite", () => {
	it("serializes the entries before it takes the session lock", () => {
		const held: boolean[] = [];
		const { internals } = session((path) => held.push(existsSync(`${realpathSync(path)}.lock`)));
		internals._rewriteFile();
		expect(held.length).toBeGreaterThan(0);
		expect(held.every((value) => !value)).toBe(true);
	});

	it("keeps a record another process appends while the content is being prepared", () => {
		let appended = false;
		const { manager, internals, file } = session((path) => {
			if (appended) return;
			appended = true;
			appendFileSync(path, `${JSON.stringify({ type: "custom", id: "foreign1", parentId: null, customType: "x" })}\n`);
		});
		const before = lines(file).length;
		internals._rewriteFile();
		const after = lines(file);
		expect(after).toHaveLength(before + 1);
		expect(after.some((record) => record.id === "foreign1")).toBe(true);
		// The state holds what the file holds.
		expect(internals.state.fileEntries).toHaveLength(after.length);
		expect(manager.getEntries().some((entry) => entry.id === "foreign1")).toBe(true);
	});
});
