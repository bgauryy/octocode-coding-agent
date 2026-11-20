import type { ApplicationPhase, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import type { WorkspaceEvent, WorkspaceSnapshot } from "@octocodeai/octocode-contracts/workspace";
import { describe, expect, it } from "vitest";
import {
	activityCard,
	ApplicationProjection,
	EventInterner,
	groupFeed,
	latestProgress,
	mergeEvents,
	runPhase,
	sessionBadge,
	settleToolStarts,
	terminalEntries,
} from "../src/app/live/model.ts";
import { jobWords } from "../src/app/live/phase-words.ts";

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
		expect([card("tool.start").tone, card("tool.start").label]).toEqual(["accent", "Tool started"]);
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

	it("runPhase reports compaction, retries and a blocking dialog ahead of the run's own phases", () => {
		const idle = { ...application, streaming: false };
		expect(runPhase({ ...idle, status: "compacting" })).toEqual({ kind: "compacting" });
		expect(runPhase({ ...idle, status: "retrying" })).toEqual({ kind: "retrying" });
		expect(runPhase({ ...idle, status: "retrying", statusDetail: "Retry 1 of 3", statusUntil: 9_000 })).toEqual({
			kind: "retrying",
			detail: "Retry 1 of 3",
			until: 9_000,
		});
		expect(runPhase({ ...idle, status: "stalled", statusDetail: "Model not answering for 25s" })).toEqual({
			kind: "stalled",
			detail: "Model not answering for 25s",
		});
		expect(runPhase({ ...idle, status: "idle" })).toEqual({ kind: "idle" });
		const awaiting = { kind: "approval", title: "Run bash?" } as const;
		expect(runPhase({ ...application, awaiting })).toEqual({ kind: "waiting", awaiting });
		// The host reports only dialogs that are open, so an idle session with one (a background subagent's) is waiting.
		expect(runPhase({ ...idle, awaiting })).toEqual({ kind: "waiting", awaiting });
	});

	it("runPhase and sessionBadge keep a settled run's job going while the host reports a pending phase, and drop it when final", () => {
		const idle = { ...application, streaming: false };
		const waiting = { state: "waiting", agents: 2, queued: 0, bash: 1, external: 0 } as const;
		expect(runPhase({ ...idle, phase: waiting })).toEqual({ kind: "job", phase: waiting });
		expect(sessionBadge({ ...idle, phase: waiting })).toEqual({
			state: "running",
			label: "Waiting on 2 agents · 1 bash",
			warn: false,
		});
		expect(runPhase({ ...idle, phase: { state: "resuming", label: "report from kid" } })).toEqual({
			kind: "job",
			phase: { state: "resuming", label: "report from kid" },
		});
		expect(jobWords({ state: "scheduled", timers: 1, id: "t1", dueAt: 61_000 }, 1_000)).toBe(
			"Waiting for timer t1 · in 1m",
		);
		const final: ApplicationPhase[] = [{ state: "done" }, { state: "idle" }, { state: "stopped", open: ["B1"] }];
		for (const phase of final) {
			expect(runPhase({ ...idle, phase })).toEqual({ kind: "idle" });
			expect(sessionBadge({ ...idle, phase })).toBeUndefined();
		}
		// A run that is active shows its own phase, whatever the host last said.
		expect(runPhase({ ...application, phase: waiting })).toMatchObject({ kind: "thinking" });
	});

	it("sessionBadge maps the phase to the shared run state, and is absent while idle", () => {
		const idle = { streaming: false } as const;
		expect(sessionBadge(idle)).toBeUndefined();
		expect(sessionBadge({ streaming: true })).toEqual({ state: "running", label: "Running", warn: false });
		expect(sessionBadge({ ...idle, status: "compacting" })).toEqual({
			state: "running",
			label: "Compacting",
			warn: false,
		});
		expect(sessionBadge({ ...idle, status: "retrying" })).toEqual({ state: "running", label: "Retrying", warn: true });
		expect(sessionBadge({ streaming: true, awaiting: { kind: "question" } })).toEqual({
			state: "waiting",
			label: "Waiting for you",
			warn: true,
		});
	});

	it("activityCard gives each state its shape: running, done, failed, stopped", () => {
		const card = (type: string, extra: Partial<WorkspaceEvent> = {}) => activityCard(event(1, type, "x", extra));
		expect(card("tool.start").ui).toBe("running");
		expect(card("tool.result").ui).toBe("done");
		expect(card("tool.result", { outcome: "failed" }).ui).toBe("failed");
		expect(card("tool.result", { details: { status: "not_run" } }).ui).toBe("stopped");
		expect(card("message", { details: { status: "streaming" } }).ui).toBe("running");
		expect(card("message", { details: { status: "completed" } }).ui).toBeUndefined();
		expect(card("session").ui).toBeUndefined();
		const aborted = card("message", { details: { status: "aborted" } });
		expect([aborted.ui, aborted.tone, aborted.label]).toEqual(["stopped", "warning", "Stopped"]);
		const interrupted = card("message", { details: { status: "interrupted" } });
		expect([interrupted.ui, interrupted.label]).toEqual(["stopped", "Stopped"]);
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
});
