import { describe, expect, it } from "vitest";
import { LOOP_NOTE_AT, LOOP_STOP_AT, loopNote, registerLoopGuard } from "../../src/octocode/loop-guard.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";

type Result = { content?: Array<{ text: string }>; structuredContent?: unknown } | undefined;

function guard() {
	const fake = fakePi();
	registerLoopGuard(fake.pi);
	const ctx = fakeCtx({ cwd: "/repo" });
	let id = 0;
	return {
		fake,
		ctx,
		call: (toolName: string, input: Record<string, unknown>, text = "same", extra: Record<string, unknown> = {}) =>
			fake.fire(
				"tool_result",
				{
					type: "tool_result",
					toolName,
					toolCallId: `c${++id}`,
					input,
					content: [{ type: "text", text }],
					isError: false,
					...extra,
				},
				ctx,
			) as Promise<Result>,
	};
}

const noteOf = (result: Result) => result?.content?.at(-1)?.text;

describe("repeated-call loop guard", () => {
	it("stays quiet below the first threshold, notes at 3, is stronger at 5 and again every 3 after", async () => {
		const { call } = guard();
		const notes: Array<string | undefined> = [];
		for (let i = 0; i < 9; i++) notes.push(noteOf(await call("mcp__octocode__localSearch", { query: "x" })));
		expect(notes.slice(0, LOOP_NOTE_AT - 1)).toEqual([undefined, undefined]);
		expect(notes[2]).toContain("returned the same result 3 times in a row");
		expect(notes[3]).toBeUndefined();
		expect(notes[LOOP_STOP_AT - 1]).toContain("5 identical");
		expect(notes[5]).toBeUndefined();
		expect(notes[6]).toBeUndefined();
		expect(notes[7]).toContain("8 identical");
	});

	it("keeps the original result and does not change a call whose result or arguments differ", async () => {
		const { call } = guard();
		for (let i = 0; i < 8; i++) expect(await call("bash", { command: "git status" }, `out ${i}`)).toBeUndefined();
		for (let i = 0; i < 8; i++) expect(await call("bash", { command: `echo ${i}` })).toBeUndefined();
		const third = await call("bash", { command: "ls" }, "a");
		expect(third).toBeUndefined();
		await call("bash", { command: "ls" }, "a");
		const noted = await call("bash", { command: "ls" }, "a", { structuredContent: { exit_code: 0 } });
		expect(noted?.content?.[0]?.text).toBe("a");
		expect(noted?.structuredContent).toEqual({ exit_code: 0 });
	});

	it("is reset by any different call and by a new prompt", async () => {
		const { call, fake, ctx } = guard();
		await call("web", { url: "u" });
		await call("web", { url: "u" });
		await call("web", { url: "other" });
		expect(await call("web", { url: "u" })).toBeUndefined();
		await call("web", { url: "u" });
		await fake.fire("before_agent_start", {}, ctx);
		expect(await call("web", { url: "u" })).toBeUndefined();
	});

	it("counts property order alike", async () => {
		const { call } = guard();
		await call("web", { url: "u", a: { x: 1, y: 2 } });
		await call("web", { a: { y: 2, x: 1 }, url: "u" });
		expect(noteOf(await call("web", { url: "u", a: { x: 1, y: 2 } }))).toContain("3 times");
	});

	it("counts an error by its call alone: the real loop got new error text every time", async () => {
		const { call } = guard();
		const notes: Array<string | undefined> = [];
		for (let i = 0; i < 3; i++)
			notes.push(noteOf(await call("file", {}, `Invalid arguments at position ${i}`, { isError: true })));
		expect(notes[2]).toContain("failed the same way 3 times");
	});

	it("exempts messaging and bookkeeping tools, nested calls and waiting shell commands", async () => {
		const { call } = guard();
		for (const tool of ["agent", "askUser", "backlog", "coordinate", "memory"])
			for (let i = 0; i < 6; i++) expect(await call(tool, { op: "list" })).toBeUndefined();
		for (let i = 0; i < 6; i++) expect(await call("bash", { command: "sleep 30; tail -n 5 job.log" })).toBeUndefined();
		for (let i = 0; i < 6; i++) expect(await call("bash", { command: "tail -f job.log" })).toBeUndefined();
		for (let i = 0; i < 6; i++)
			expect(await call("web", { url: "n" }, "same", { parentToolCallId: "p" })).toBeUndefined();
	});

	it("words the notes for a failing and a repeating call", () => {
		expect(loopNote("bash", 2, false)).toBeUndefined();
		expect(loopNote("bash", 3, true)).toContain("failed the same way");
		expect(loopNote("bash", 5, false)).toContain("report that you are blocked");
	});
});
