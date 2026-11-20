import { describe, expect, it, vi } from "vitest";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { contextOf, contextText, handItem } from "../../src/octocode/subagents/hand-item.ts";
import { HandedItems } from "../../src/octocode/subagents/handed-items.ts";
import { handAndSend } from "../../src/octocode/team/tools/hand.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const READY = { goal: "Expected result", why: "Required work", createdBy: "user" as const };
const NOBODY = { onItem: () => undefined };

/** A session with two running children: kid (started for B1) and sib, and three items. */
function setup(live: { contextTokens?: number; contextWindow?: number } = {}) {
	const ctx = fakeCtx({ cwd: tmp() });
	const backlog = openBacklog(ctx, { isSubagent: false });
	const { store, session } = backlog;
	const start = store.add({ ...READY, title: "start", state: "todo", paths: ["src/a"] });
	store.update(start.ref, { state: "ongoing" }, backlog.actor);
	const next = store.add({ ...READY, title: "next", state: "todo", paths: ["src/a/b.ts", "docs"] });
	const far = store.add({ ...READY, title: "far", state: "todo", paths: ["web"] });
	const runs = {
		running: new Map<string, undefined>([
			["kid", undefined],
			["sib", undefined],
		]),
		items: new Map([["kid", start.ref]]),
		live: new Map([["kid", live]]),
		handed: new HandedItems(),
	} as unknown as Parameters<typeof handItem>[0];
	// What the child's backlog tool acts as: bound to its start item, under this session.
	const kid = { id: "kid", owners: new Set([session]), item: start.ref };
	return { ctx, store, session, start, next, far, runs, kid };
}

describe("handing an item to a running child", () => {
	it("claims the item, lets the child update it until its run ends, and names context and shared paths", () => {
		const { ctx, store, session, start, next, runs, kid } = setup({ contextTokens: 150_000, contextWindow: 200_000 });
		expect(() => store.update(next.ref, { note: "mine?" }, kid)).toThrow(/not claimed by your coordinator/);
		const handoff = handItem(runs, NOBODY, "kid", next.ref, ctx);
		expect(store.get(next.ref)).toMatchObject({ state: "ongoing", assignee: session });
		expect(handoff.notice).toContain(`${next.ref} (next)`);
		expect(handoff.notice).toContain("Expected result");
		expect(handoff.summary).toContain(`Claimed ${next.ref} for kid`);
		expect(handoff.summary).toContain("context 75% (150k of 200k): near full");
		expect(handoff.summary).toContain(`Shares src/a/b.ts with its item ${start.ref}.`);
		expect(store.update(next.ref, { note: "on it" }, kid).ref).toBe(next.ref);
		expect(store.tasks.add({ goal: "step done", item: next.ref }, kid).goal).toBe("step done");
		// The run ends: the grant goes with it.
		runs.handed?.end("kid");
		expect(() => store.update(next.ref, { note: "still?" }, kid)).toThrow(/is not your item/);
	});

	it("refuses a child that is not running, the child's own item, an item another child serves and a finished one", () => {
		const { ctx, store, start, next, far, runs } = setup();
		expect(() => handItem(runs, NOBODY, "ghost", next.ref, ctx)).toThrow(/ghost is not a running subagent you started/);
		expect(() => handItem(runs, NOBODY, "kid", start.ref, ctx)).toThrow(/already kid's item/);
		handItem(runs, NOBODY, "sib", next.ref, ctx);
		expect(() => handItem(runs, NOBODY, "kid", next.ref, ctx)).toThrow(/being worked on by sib/);
		expect(() => handItem(runs, { onItem: () => "old" }, "kid", far.ref, ctx)).toThrow(/with old/);
		store.update(far.ref, { close: { kind: "wont_do", text: "no" } }, { id: "human", surface: "command" });
		expect(() => handItem(runs, NOBODY, "kid", far.ref, ctx)).toThrow(/is done/);
	});

	it("says when the child's context is not known yet, and undo takes the item back", () => {
		const { ctx, store, far, runs, kid } = setup();
		const handoff = handItem(runs, NOBODY, "kid", far.ref, ctx);
		expect(handoff.summary).toContain("Its context is not known yet");
		expect(handoff.summary).toContain("Shares no paths with its item");
		handoff.undo();
		expect(() => store.update(far.ref, { note: "x" }, kid)).toThrow(/is not your item/);
	});
});

describe("context fill", () => {
	it("reads a running child's latest reply and formats it", () => {
		const runs = { running: new Map([["a", undefined]]), live: new Map([["a", { contextTokens: 40_000 }]]) };
		expect(contextOf(runs as never, "a")).toEqual({ used: 40_000 });
		expect(contextOf(runs as never, "gone")).toBeUndefined();
		expect(contextText({ used: 40_000 })).toBe("context 40k");
		expect(contextText({ used: 50_000, window: 200_000 })).toBe("context 25% (50k of 200k)");
	});
});

describe("handAndSend", () => {
	const ctx = {} as never;
	const handoff = () => ({ notice: "You got B2.", summary: "Claimed B2 for kid.", undo: vi.fn() });

	it("puts the notice before the message and the hand-over after the reply", async () => {
		const made = handoff();
		const send = vi.fn(async (params: { message?: string }) => ({
			content: [{ type: "text" as const, text: `Queued: ${params.message}` }],
			details: {},
		}));
		const result = await handAndSend(() => made, { to: "kid", message: "Do it." }, "B2", ctx, send);
		expect(send.mock.calls[0]?.[0]).toMatchObject({ to: "kid", message: "You got B2.\n\nDo it." });
		expect(result.content[0]?.text).toBe("Queued: You got B2.\n\nDo it. Claimed B2 for kid.");
		expect(made.undo).not.toHaveBeenCalled();
	});

	it("takes the item back when the send fails, and refuses what cannot carry an item", async () => {
		const made = handoff();
		const failing = vi.fn(async () => {
			throw new Error("mailbox down");
		});
		await expect(handAndSend(() => made, { to: "kid" }, "B2", ctx, failing)).rejects.toThrow("mailbox down");
		expect(made.undo).toHaveBeenCalledOnce();
		await expect(handAndSend(undefined, { to: "kid" }, "B2", ctx, failing)).rejects.toThrow(/Only the agent/);
		await expect(handAndSend(() => made, { to: "all" }, "B2", ctx, failing)).rejects.toThrow(/one running subagent/);
		await expect(handAndSend(() => made, { to: "kid", forward: 3 }, "B2", ctx, failing)).rejects.toThrow(
			/not a forward/,
		);
	});
});
