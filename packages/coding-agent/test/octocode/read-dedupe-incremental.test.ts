import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { registerReadDedupe } from "../../src/octocode/files/dedupe.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

function setup() {
	const session = SessionManager.inMemory("/repo");
	const fake = fakeHost();
	registerReadDedupe(fake.api);
	const ctx = Object.assign(fakeCtx({ cwd: "/repo" }), { sessionManager: session });
	const run = (file: string, text: string) =>
		fake.fire(
			"tool_result",
			{
				type: "tool_result",
				toolName: "read",
				toolCallId: "new",
				input: { path: file },
				content: [{ type: "text", text }],
				isError: false,
			},
			ctx,
		);
	const add = (id: string, file: string, text: string, read?: () => void) => {
		session.appendMessage(fauxAssistantMessage([{ type: "toolCall", id, name: "read", arguments: { path: file } }]));
		return session.appendMessage({
			role: "toolResult",
			toolName: "read",
			toolCallId: id,
			isError: false,
			timestamp: 1,
			content: [
				{
					type: "text",
					get text() {
						read?.();
						return text;
					},
				},
			],
		});
	};
	return { session, run, add };
}

describe("incremental read dedupe", () => {
	it("visits prior content once in a 10,000-entry session and indexes only appended reads", async () => {
		const s = setup();
		let touched = 0;
		for (let index = 0; index < 5_000; index++) s.add(`c${index}`, `f${index}`, `text${index}`, () => touched++);
		const projection = vi.spyOn(s.session, "buildSessionProjection");
		const branch = vi.spyOn(s.session, "getBranch");
		expect(await s.run("f4999", "text4999")).toMatchObject({ details: { unchangedOf: "c4999" } });
		const initial = touched;
		const initialBranches = branch.mock.calls.length;
		for (let index = 0; index < 20; index++) await s.run("f4999", "text4999");
		expect(touched).toBe(initial);
		expect(projection).toHaveBeenCalledTimes(1);
		expect(branch).toHaveBeenCalledTimes(initialBranches);
		let added = 0;
		s.add("added", "next", "new text", () => added++);
		expect(await s.run("next", "new text")).toMatchObject({ details: { unchangedOf: "added" } });
		expect(added).toBeGreaterThan(0);
		expect(touched).toBe(initial);
		expect(projection).toHaveBeenCalledTimes(1);
		expect(branch).toHaveBeenCalledTimes(initialBranches);
	});

	it("invalidates results after context edits, compaction, and switching branches", async () => {
		const s = setup();
		const first = s.add("first", "a", "original");
		expect(await s.run("a", "original")).toBeDefined();
		s.session.appendContextEdit(first, { content: "replacement" });
		expect(await s.run("a", "original")).toBeUndefined();
		expect(await s.run("a", "replacement")).toMatchObject({ details: { unchangedOf: "first" } });
		s.session.appendCompaction("summary", null, 100);
		expect(await s.run("a", "replacement")).toBeUndefined();
		s.add("second", "b", "new branch");
		expect(await s.run("b", "new branch")).toBeDefined();
		s.session.branch(first);
		expect(await s.run("a", "original")).toMatchObject({ details: { unchangedOf: "first" } });
		expect(await s.run("b", "new branch")).toBeUndefined();
	});
});
