import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { oracleProjection, runProperty } from "./projection-property.ts";

const seeds = Array.from({ length: 12 }, (_, i) => i + 1);

describe("kept session projection", () => {
	// Drafts and entries are stamped with the clock; a fixed clock lets a preview and its copy compare equal.
	beforeAll(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
	});
	afterAll(() => vi.useRealTimers());

	it("matches the whole-branch computation on random session trees", () => {
		expect(runProperty(seeds, 400)).toEqual([]);
	});

	it("never changes what it handed out: every projection frozen as it is returned", () => {
		expect(runProperty([101, 102, 103], 200, { freeze: true })).toEqual([]);
	});

	it("gives each read arrays and entry records of its own", () => {
		const session = SessionManager.inMemory("/tmp/projection-own");
		const user = session.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
		session.appendCustomMessageEntry("note", "custom", true);
		session.appendModelChange("p", "m");
		const first = session.buildSessionProjection();
		first.messages.push({ role: "user", content: "extra", timestamp: 2 });
		first.messages.length = 0;
		first.entries[0].messages.length = 0;
		first.entries.reverse();
		first.entries.push(first.entries[0]);
		first.model!.provider = "changed";
		session.buildContextEntries().pop();
		expect(session.buildSessionProjection()).toEqual(oracleProjection(session));
		expect(session.buildContextEntries().map((entry) => entry.id)[0]).toBe(user);
	});

	it("keeps the projected custom messages from one read to the next, so views compare them by identity", () => {
		const session = SessionManager.inMemory("/tmp/projection-identity");
		session.appendCustomMessageEntry("note", "custom", true);
		const before = session.buildSessionProjection().messages[0];
		session.appendMessage({ role: "user", content: [{ type: "text", text: "next" }], timestamp: 1 });
		expect(session.buildSessionProjection().messages[0]).toBe(before);
	});

	it("previews drafts without changing the session", () => {
		const session = SessionManager.inMemory("/tmp/projection-preview");
		const target = session.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
		const leaf = session.getLeafId();
		const preview = session.previewProjection((appender) => {
			appender.appendCustomMessageEntry("draft", "draft text", false);
			appender.appendContextEdit(target, null);
		});
		expect(preview?.messages).toEqual([expect.objectContaining({ role: "custom", content: "draft text" })]);
		expect(session.getLeafId()).toBe(leaf);
		expect(session.getEntryCount()).toBe(1);
		expect(session.buildSessionProjection()).toEqual(oracleProjection(session));
	});
});
