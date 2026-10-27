import type { ApplicationSnapshot } from "@octocodeai/octocode-contacts";
import type { WorkspaceEvent, WorkspaceSnapshot } from "@octocodeai/octocode-contacts/workspace";
import { describe, expect, it } from "vitest";
import {
	activityCard,
	ApplicationProjection,
	EventInterner,
	fileDiffs,
	groupFeed,
	latestProgress,
	mergeEvents,
	runPhase,
	settleToolStarts,
	terminalEntries,
} from "../src/app/live/model.ts";

function event(id: number, type: string, text = "", extra: Partial<WorkspaceEvent> = {}): WorkspaceEvent {
	return { id, at: id, type, text, ...extra };
}
const application: ApplicationSnapshot = {
	sessionId: "s",
	messages: [],
	streaming: true,
	runId: "r",
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: [],
};

describe("activityCard", () => {
	it("assigns tone and label by event family, passing unknown types through as their label", () => {
		const card = (type: string) => activityCard(event(1, type, "line"));
		expect([card("tool.start").tone, card("tool.start").label]).toEqual(["tool", "Tool started"]);
		expect([card("agent.start").tone, card("agent.start").label]).toEqual(["agent", "Agent started"]);
		expect([card("tool.result").tone, card("agent.result").tone]).toEqual(["success", "success"]);
		expect([card("session").tone, card("session").label]).toEqual(["neutral", "Session"]);
		expect([card("custom.kind").tone, card("custom.kind").label]).toEqual(["neutral", "custom.kind"]);
	});

	it("status reads scalar details as text and ignores objects and arrays", () => {
		const status = (value: unknown) => activityCard(event(1, "session", "x", { details: { status: value } })).status;
		expect(status("running")).toBe("running");
		expect(status(3)).toBe("3");
		expect(status(false)).toBe("false");
		expect(status({ nested: true })).toBeUndefined();
		expect(status(["a"])).toBeUndefined();
	});

	it("an agent result with a non-scalar summary falls back to the default title and an empty body", () => {
		const card = activityCard(event(1, "agent.result", "raw", { details: { summary: { a: 1 }, body: ["x"] } }));
		expect(card.title).toBe("Agent result");
		expect(card.body).toBe("");
		expect(card.files).toEqual([]);
	});

	it("messages and progress keep their whole text as the body under a fixed title", () => {
		expect(activityCard(event(1, "message", "a\nb"))).toMatchObject({ title: "Agent message", body: "a\nb" });
		expect(activityCard(event(1, "agent.progress", "a\nb"))).toMatchObject({ title: "Progress update", body: "a\nb" });
	});

	it("records thinking time only when the detail is a number", () => {
		expect(activityCard(event(1, "message", "x", { details: { thoughtMs: 1200 } })).thoughtMs).toBe(1200);
		expect(activityCard(event(1, "message", "x", { details: { thoughtMs: "1200" } })).thoughtMs).toBeUndefined();
	});
});

describe("projection and merging", () => {
	it("retains user messages and skips legacy assistant messages with no visible content", () => {
		const events = new ApplicationProjection().update(
			{
				...application,
				messages: [
					{ id: "u", role: "user", text: "question", complete: true },
					{ id: "a1", role: "assistant", text: "   ", complete: true },
					{ id: "a2", role: "assistant", text: "[Tool call: read]", complete: true },
					{ id: "a3", role: "assistant", text: "answer", complete: false },
				],
			},
			1,
		);
		expect(events.map((item) => [item.type, item.text, (item.details as { status: string }).status])).toEqual([
			["message", "question", "completed"],
			["message", "answer", "streaming"],
		]);
	});

	it("projects tool status into start/result events and marks failed calls with an outcome", () => {
		const events = new ApplicationProjection().update(
			{
				...application,
				tools: [
					{ toolCallId: "a", toolName: "read", text: "", status: "running" },
					{ toolCallId: "b", toolName: "bash", text: "ok", status: "completed" },
					{ toolCallId: "c", toolName: "bash", text: "err", status: "failed" },
				],
			},
			1,
		);
		expect(events.map((item) => [item.type, item.outcome])).toEqual([
			["tool.start", undefined],
			["tool.result", undefined],
			["tool.result", "failed"],
		]);
		expect(new Set(events.map((item) => item.id)).size).toBe(3);
		expect(events.every((item) => item.id < 0)).toBe(true);
	});

	it("clears the run when the session stops streaming", () => {
		const projection = new ApplicationProjection();
		projection.update(application, 5);
		expect(projection.run).toEqual({ id: "r", startedAt: 5 });
		projection.update({ ...application, streaming: false }, 6);
		expect(projection.run).toBeUndefined();
		projection.update(undefined, 7);
		expect(projection.run).toBeUndefined();
	});

	it("mergeEvents ignores application events when no application session is known", () => {
		const domain: WorkspaceSnapshot = {
			sessionId: "s",
			agents: [],
			traffic: [],
			receipts: [],
			events: [event(1, "session")],
		};
		expect(mergeEvents(domain, [event(-1, "message")], undefined).events.map((item) => item.id)).toEqual([1]);
		expect(mergeEvents(domain, [event(-1, "message", "", { at: 0 })], "s").events.map((item) => item.id)).toEqual([
			-1, 1,
		]);
	});

	it("EventInterner returns a new object for an event whose content changed and forgets ids that disappear", () => {
		const interner = new EventInterner();
		const first = event(1, "message", "a");
		const [kept] = interner.intern([first]);
		expect(interner.intern([{ ...first }])[0]).toBe(kept);
		const [changed] = interner.intern([{ ...first, text: "b" }]);
		expect(changed).not.toBe(kept);
		expect(changed.text).toBe("b");
		interner.intern([]);
		expect(interner.intern([{ ...first, text: "b" }])[0]).not.toBe(changed);
	});
});

describe("feed shaping", () => {
	it("groupFeed leaves a single tool event ungrouped and counts failed tools in a group", () => {
		const entries = groupFeed([
			event(1, "message"),
			event(2, "tool.start"),
			event(3, "message"),
			event(4, "tool.result", "", { outcome: "failed" }),
			event(5, "tool.start"),
		]);
		expect(entries.map((entry) => entry.kind)).toEqual(["event", "event", "event", "tools"]);
		const group = entries[3];
		expect(group.kind === "tools" && group.summary).toEqual({ total: 2, running: 1, failed: 1, done: 1, notRun: 0 });
		expect(group.kind === "tools" && group.id).toBe(4);
	});

	it("runPhase picks the most recent running tool and treats an empty partial answer as thinking", () => {
		expect(
			runPhase({
				...application,
				tools: [
					{ toolCallId: "1", toolName: "read", text: "", status: "running" },
					{ toolCallId: "2", toolName: "bash", text: "", status: "running" },
					{ toolCallId: "3", toolName: "grep", text: "", status: "completed" },
				],
			}),
		).toEqual({ kind: "tool", name: "bash" });
		expect(runPhase({ ...application, messages: [{ id: "m", role: "assistant", text: "", complete: false }] })).toEqual(
			{ kind: "thinking" },
		);
		expect(runPhase(undefined)).toEqual({ kind: "idle" });
	});

	it("terminalEntries ignores non-tool events and reports failures from details status", () => {
		expect(
			terminalEntries([
				event(1, "message", "hi"),
				event(2, "tool.result", "bash\nboom", { details: { status: "error" } }),
			]),
		).toEqual([{ id: 2, at: 2, command: "bash", output: "boom", status: "failed" }]);
	});

	it("settleToolStarts pairs starts and results per tool name, oldest start first", () => {
		const events = [
			event(1, "tool.start", "read", { details: { hint: "a.ts" } }),
			event(2, "tool.start", "read", { details: { hint: "b.ts" } }),
			event(3, "tool.start", "bash"),
			event(4, "tool.result", "read\nA"),
		];
		const settled = settleToolStarts(events);
		expect(settled.map((item) => item.id)).toEqual([2, 3, 4]);
		expect(settled.find((item) => item.id === 4)?.hint).toBe("a.ts");
	});

	it("latestProgress keeps the latest report per agent id independently", () => {
		const progress = (id: number, agent: string) =>
			event(id, "agent.progress", `${agent}${id}`, { details: { id: agent } });
		const kept = latestProgress([progress(1, "x"), progress(2, "y"), progress(3, "x"), event(4, "message")]);
		expect(kept.map((item) => item.id)).toEqual([2, 3, 4]);
	});

	it("fileDiffs keeps only successful outcomes with a non-empty diff and defaults the type to edit", () => {
		expect(
			fileDiffs({
				outcomes: [
					{ ok: true, path: "a.ts", diff: "@@ a" },
					{ ok: true, path: "b.ts", type: "create", diff: "@@ b" },
					{ ok: false, path: "c.ts", diff: "@@ c" },
					{ ok: true, path: "d.ts", diff: "" },
					{ ok: true, path: { bad: true }, diff: "@@ e" },
					"junk",
				],
			}),
		).toEqual([
			{ path: "a.ts", type: "edit", diff: "@@ a" },
			{ path: "b.ts", type: "create", diff: "@@ b" },
			{ path: "", type: "edit", diff: "@@ e" },
		]);
		expect(fileDiffs({ outcomes: "nope" })).toEqual([]);
		expect(fileDiffs(null)).toEqual([]);
	});
});
