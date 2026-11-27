import { describe, expect, it } from "vitest";
import {
	LOOP_HALT_AT,
	LOOP_NOTE_AT,
	LOOP_STOP_AT,
	loopNote,
	registerLoopGuard,
} from "../../src/octocode/loop-guard.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

type Result = { message: { content: Array<{ text: string }>; structuredContent?: unknown } } | undefined;

/** Fire the events the agent loop sends for one top-level call: start, the executed result unless `blocked`, then the message. */
function guard() {
	const fake = fakeHost();
	// The `loop` step, run on `tool_call` as the pipeline runs it first (`tool-gates.ts`).
	const loop = registerLoopGuard(fake.api);
	fake.api.bus.on("tool_call", (event, ctx) => loop(event, ctx));
	const ctx = fakeCtx({ cwd: "/repo" });
	let id = 0;
	return {
		fake,
		ctx,
		call: async (
			toolName: string,
			input: Record<string, unknown>,
			text = "same",
			extra: { isError?: boolean; parentToolCallId?: string; structuredContent?: unknown; blocked?: boolean } = {},
		) => {
			const toolCallId = `c${++id}`;
			const { blocked, ...rest } = extra;
			const isError = Boolean(blocked || rest.isError);
			const content = [{ type: "text", text }];
			await fake.fire(
				"tool_execution_start",
				{ type: "tool_execution_start", toolCallId, toolName, args: input, ...rest },
				ctx,
			);
			if (!blocked)
				await fake.fire(
					"tool_result",
					{ type: "tool_result", toolName, toolCallId, input, content, ...rest, isError },
					ctx,
				);
			if (rest.parentToolCallId) return undefined;
			const message = {
				role: "toolResult",
				toolCallId,
				toolName,
				content,
				isError,
				timestamp: 0,
				...(rest.structuredContent !== undefined ? { structuredContent: rest.structuredContent } : {}),
			};
			return (await fake.fire("message_end", { type: "message_end", message }, ctx)) as Result;
		},
		before: (toolName: string, input: Record<string, unknown>) =>
			fake.fire("tool_call", { type: "tool_call", toolName, toolCallId: `c${id + 1}`, input }, ctx) as Promise<
				{ block?: boolean; terminate?: boolean; reason?: string } | undefined
			>,
	};
}

/** The stronger note due at a streak of `count`. */
const stopNote = (tool: string, count: number) => loopNote(tool, count, false)!;
const noteOf = (result: Result) => result?.message.content.at(-1)?.text;

describe("repeated-call loop guard", () => {
	it("stays quiet below the first threshold, notes at 3, is stronger at 5 and again every 3 after", async () => {
		const { call } = guard();
		const notes: Array<string | undefined> = [];
		for (let i = 0; i < 9; i++) notes.push(noteOf(await call("mcp__octocode__localSearch", { query: "x" })));
		expect(notes.slice(0, LOOP_NOTE_AT - 1)).toEqual([undefined, undefined]);
		expect(notes[2]).toContain(loopNote("mcp__octocode__localSearch", 3, false)!);
		expect(notes[3]).toBeUndefined();
		expect(notes[LOOP_STOP_AT - 1]).toContain(stopNote("mcp__octocode__localSearch", 5));
		expect(notes[5]).toBeUndefined();
		expect(notes[6]).toBeUndefined();
		expect(notes[7]).toContain(stopNote("mcp__octocode__localSearch", 8));
	});

	it("keeps the original result and does not change a call whose result or arguments differ", async () => {
		const { call } = guard();
		for (let i = 0; i < 8; i++) expect(await call("bash", { command: "git status" }, `out ${i}`)).toBeUndefined();
		for (let i = 0; i < 8; i++) expect(await call("bash", { command: `echo ${i}` })).toBeUndefined();
		const third = await call("bash", { command: "ls" }, "a");
		expect(third).toBeUndefined();
		await call("bash", { command: "ls" }, "a");
		const noted = await call("bash", { command: "ls" }, "a", { structuredContent: { exit_code: 0 } });
		expect(noted?.message.content[0]?.text).toBe("a");
		expect(noted?.message.structuredContent).toEqual({ exit_code: 0 });
	});

	it("counts model listings that differ only in spend and resets on a changed catalog", async () => {
		const { call, before } = guard();
		for (let i = 0; i < LOOP_HALT_AT; i++) {
			const text = `  test (this session): spent ≈$1.${i}
This session spent ≈$3.${i} (replies, summaries and subagents; plan at list price).
Model A`;
			const result = await call("models", { reason: String(i) }, text);
			if (i + 1 === LOOP_NOTE_AT) {
				expect(result?.message.content[0]?.text).toBe(text);
				expect(noteOf(result)).toContain("3 times");
			}
		}
		expect(await before("models", {})).toMatchObject({ terminate: true });
		expect(await call("models", {}, "Model B")).toBeUndefined();
		expect(await before("models", {})).toBeUndefined();
	});

	it("only counts consecutive sentences within one assistant text block", async () => {
		const { fake, ctx } = guard();
		const sentence = "Should use the Octocode tools. ";
		const send = (type: string, contentIndex: number, delta: string) =>
			fake.fire("message_update", { assistantMessageEvent: { type, contentIndex, delta } }, ctx);
		await send("toolcall_delta", 0, sentence.repeat(80));
		await send("thinking_delta", 1, sentence.repeat(80));
		await send("text_delta", 2, sentence.repeat(15));
		await send("text_delta", 3, sentence.repeat(15));
		await send("text_delta", 3, "The check succeeded. " + sentence.repeat(15));
		expect(ctx.ui.notes).toHaveLength(0);
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
		expect(notes[2]).toContain(loopNote("file", 3, true)!);
	});

	it("exempts messaging and bookkeeping tools, nested calls and waiting shell commands", async () => {
		const { call } = guard();
		for (const tool of ["agent", "askUser", "backlog", "backlogPlan", "coordinate"])
			for (let i = 0; i < 6; i++) expect(await call(tool, { op: "list" })).toBeUndefined();
		for (let i = 0; i < 6; i++) expect(await call("bash", { command: "sleep 30; tail -n 5 job.log" })).toBeUndefined();
		for (let i = 0; i < 6; i++) expect(await call("bash", { command: "tail -f job.log" })).toBeUndefined();
		for (let i = 0; i < 6; i++)
			expect(await call("web", { url: "n" }, "same", { parentToolCallId: "p" })).toBeUndefined();
	});

	it("counts repeated calls to the removed steps tool like any other unknown call", async () => {
		const { call } = guard();
		const refusal = "Tool steps not found: it was removed.";
		for (let i = 0; i < 2; i++) await call("steps", { op: "list" }, refusal, { isError: true });
		expect(noteOf(await call("steps", { op: "list" }, refusal, { isError: true }))).toContain("3 times");
	});

	it("ignores the reworded reason of a retried call, at any depth", async () => {
		const { call } = guard();
		await call("bash", { command: "npm test", reason: "Run tests" });
		await call("bash", { command: "npm test", reason: "Re-run tests" });
		expect(noteOf(await call("bash", { command: "npm test", reason: "Try again" }))).toContain("3 times");
		await call("file", { queries: [{ path: "a", reason: "x" }] });
		await call("file", { queries: [{ path: "a", reason: "y" }] });
		expect(noteOf(await call("file", { queries: [{ path: "a", reason: "z" }] }))).toContain("3 times");
	});

	it("counts blocked calls, which never reach tool_result", async () => {
		const { call } = guard();
		await call("bash", { command: "rm -rf build" }, "Blocked by user", { blocked: true });
		await call("bash", { command: "rm -rf build" }, "Blocked by user", { blocked: true });
		expect(noteOf(await call("bash", { command: "rm -rf build" }, "Blocked", { blocked: true }))).toContain(
			loopNote("bash", 3, true)!,
		);
	});

	it("says the loop guard ended the run, since the model gets no turn to", async () => {
		const { call, before, ctx } = guard();
		for (let i = 0; i < LOOP_HALT_AT; i++) await call("web", { url: "u" });
		expect((await before("web", { url: "u" }))?.terminate).toBe(true);
		expect(ctx.ui.notes.at(-1)).toMatchObject({
			type: "error",
			message: expect.stringContaining(`${LOOP_HALT_AT}`),
		});
	});

	it(`refuses the same call and ends the run after ${LOOP_HALT_AT} identical outcomes`, async () => {
		const { call, before, fake, ctx } = guard();
		for (let i = 0; i < LOOP_HALT_AT - 1; i++) await call("web", { url: "u" });
		expect(await before("web", { url: "u" })).toBeUndefined();
		await call("web", { url: "u" });
		expect(await before("web", { url: "other" })).toBeUndefined();
		const refused = await before("web", { url: "u", reason: "once more" });
		expect(refused).toMatchObject({ block: true, terminate: true });
		expect(refused?.reason).toContain("web");
		await fake.fire("before_agent_start", {}, ctx);
		expect(await before("web", { url: "u" })).toBeUndefined();
	});

	it("gives a failing call a different note than a repeating one, and a longer streak a different one than a short", () => {
		expect(loopNote("bash", 2, false)).toBeUndefined();
		expect(loopNote("bash", 3, true)).toBeDefined();
		expect(loopNote("bash", 3, true)).not.toBe(loopNote("bash", 3, false));
		expect(loopNote("bash", 5, false)).toBeDefined();
		expect(loopNote("bash", 5, false)).not.toBe(loopNote("bash", 3, false));
	});

	it("halts a call whose arguments validation coerces, comparing the same raw arguments it counted", async () => {
		const { fake, ctx, call } = guard();
		const raw = { queries: '[{"path":"a"}]' };
		for (let i = 0; i < LOOP_HALT_AT; i++) await call("file", raw, "Invalid arguments", { isError: true });
		// The tool_call event carries the validated (coerced) input; the call id links it to the raw arguments.
		await fake.fire(
			"tool_execution_start",
			{ type: "tool_execution_start", toolCallId: "next", toolName: "file", args: raw },
			ctx,
		);
		const refused = await fake.fire(
			"tool_call",
			{ type: "tool_call", toolName: "file", toolCallId: "next", input: { queries: [{ path: "a" }] } },
			ctx,
		);
		expect(refused).toMatchObject({ block: true, terminate: true });
	});

	it("restarts a successful streak after any other call, exempt ones included", async () => {
		const { call } = guard();
		await call("web", { url: "u" });
		await call("web", { url: "u" });
		await call("askUser", { question: "?" });
		expect(noteOf(await call("web", { url: "u" }))).toBeUndefined();
		await call("web", { url: "u" });
		expect(noteOf(await call("web", { url: "u" }))).toContain("3 times");
	});

	it("exempts only commands that wait, not every command that mentions a waiting word", async () => {
		const { call } = guard();
		for (let i = 0; i < 2; i++) await call("bash", { command: 'grep -rn "poll" src' });
		expect(noteOf(await call("bash", { command: 'grep -rn "poll" src' }))).toContain("3 times");
		for (let i = 0; i < 4; i++) expect(await call("bash", { command: "npm run build && sleep 5" })).toBeUndefined();
	});
});
