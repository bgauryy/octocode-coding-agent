import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	headerInContext,
	injectedIds,
	MEMORY_HEADER,
	MEMORY_MESSAGE_TYPE,
	sessionInjections,
} from "../../src/octocode/memory/inject.ts";

const content = `${MEMORY_HEADER}\nM7 (project, fact) "Parser" — "Read tokens first"`;

function setup() {
	const session = SessionManager.inMemory();
	const id = session.appendCustomMessageEntry(MEMORY_MESSAGE_TYPE, content, false, { ids: [7], updated: [123] });
	expect(sessionInjections(session)).toEqual({ injected: new Map([[7, 123]]), headerInContext: true });
	return { session, id };
}

function expectRecall(session: SessionManager, ids: number[], whole: boolean) {
	expect([...sessionInjections(session).injected.keys()]).toEqual(ids);
	expect(sessionInjections(session).headerInContext).toBe(whole);
	expect([...injectedIds(session.getBranch()).keys()]).toEqual(ids);
	expect(headerInContext(session.getBranch())).toBe(whole);
}

describe("memory recall after context edits", () => {
	it("recalls memories and their caveat again after their injection was omitted", () => {
		const { session, id } = setup();
		session.appendContextEdit(id, null);
		expect(session.buildSessionContext().messages).toHaveLength(0);
		expectRecall(session, [], false);
	});

	it("does not trust stale ids after replacement, even when the caveat survives", () => {
		const { session, id } = setup();
		session.appendContextEdit(id, { content: `${MEMORY_HEADER}\nMemory details were removed.` });
		expectRecall(session, [], true);
		session.appendContextEdit(id, { content: "Memory details were removed." });
		expectRecall(session, [], false);
	});

	it("recognizes restored original content and a branch before the edit", () => {
		const { session, id } = setup();
		session.appendContextEdit(id, null);
		expectRecall(session, [], false);
		session.appendContextEdit(id, { content: [{ type: "text", text: content }] });
		expectRecall(session, [7], true);
		session.branch(id);
		expectRecall(session, [7], true);
	});

	it("keeps an omission effective through compaction when its target remains", () => {
		const { session, id } = setup();
		session.appendContextEdit(id, null);
		session.appendCompaction("Earlier conversation", id, 100);
		expect(session.buildSessionContext().messages).toHaveLength(1);
		expectRecall(session, [], false);
	});
});
