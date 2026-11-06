import type { ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import type { WorkspaceEvent } from "@octocodeai/octocode-contracts/workspace";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { NoticeTracker, shouldNotify } from "../src/app/model/notifications.ts";
import { SERVICE_WORKER_JS } from "../src/index.ts";

function snapshot(overrides: Partial<ApplicationSnapshot> = {}): ApplicationSnapshot {
	return {
		sessionId: "s",
		messages: [],
		streaming: false,
		steering: [],
		followUp: [],
		receipts: [],
		capabilities: [],
		...overrides,
	};
}
const event = (id: number, type: string, extra: Partial<WorkspaceEvent> = {}): WorkspaceEvent => ({
	id,
	at: 0,
	type,
	text: `${type} ${id}`,
	...extra,
});
const feed = (...events: WorkspaceEvent[]) => ({ sessionId: "s", events });

describe("NoticeTracker", () => {
	it("notifies once for an approval and once for a question, keyed by the dialog", () => {
		const tracker = new NoticeTracker();
		const approval = snapshot({ awaiting: { kind: "approval", id: "d1", title: "Run rm?" } });
		expect(tracker.observe(approval, undefined)).toMatchObject([
			{ kind: "approval", body: "Run rm?", hash: "#activity" },
		]);
		// A re-render, a reconnect snapshot or a new frame with the same dialog repeats nothing.
		expect(tracker.observe(approval, undefined)).toEqual([]);
		expect(
			tracker.observe(snapshot({ awaiting: { kind: "approval", id: "d1", title: "Run rm?" } }), undefined),
		).toEqual([]);
		expect(tracker.observe(snapshot(), undefined)).toEqual([]);
		expect(
			tracker.observe(snapshot({ awaiting: { kind: "question", id: "d2", title: "Which one?" } }), undefined),
		).toMatchObject([{ kind: "question", body: "Which one?" }]);
	});

	it("notifies when a turn finishes, once, with the reply as the body", () => {
		const tracker = new NoticeTracker();
		expect(tracker.observe(snapshot({ streaming: true, runId: "r1" }), undefined)).toEqual([]);
		const done = snapshot({
			messages: [{ id: "m", role: "assistant", text: "All done\nmore", complete: true, status: "completed" }],
		});
		expect(tracker.observe(done, undefined)).toMatchObject([{ kind: "finished", body: "All done" }]);
		expect(tracker.observe(done, undefined)).toEqual([]);
	});

	it("reports a turn that ended with an error as failed, and stays silent for a stopped one", () => {
		const failed = new NoticeTracker();
		failed.observe(snapshot({ streaming: true, runId: "r1" }), undefined);
		expect(
			failed.observe(
				snapshot({
					messages: [
						{
							id: "m",
							role: "assistant",
							text: "",
							complete: true,
							status: "failed",
							errorMessage: "Provider is down",
						},
					],
				}),
				undefined,
			),
		).toMatchObject([{ kind: "failed", body: "Provider is down" }]);
		const stopped = new NoticeTracker();
		stopped.observe(snapshot({ streaming: true, runId: "r1" }), undefined);
		expect(
			stopped.observe(
				snapshot({ messages: [{ id: "m", role: "assistant", text: "", complete: true, status: "aborted" }] }),
				undefined,
			),
		).toEqual([]);
	});

	it("treats events present at first sight as history, then notifies agent results and failures once", () => {
		const tracker = new NoticeTracker();
		const history = [
			event(1, "agent.result", { outcome: "succeeded" }),
			event(2, "agent.result", { outcome: "failed" }),
		];
		expect(tracker.observe(undefined, feed(...history))).toEqual([]);
		const next = [
			...history,
			event(3, "agent.result", { outcome: "succeeded" }),
			event(4, "agent.result", { outcome: "failed" }),
			event(5, "tool.result", { outcome: "failed" }),
			event(6, "agent.progress"),
		];
		expect(tracker.observe(undefined, feed(...next))).toMatchObject([
			{ kind: "finished", title: "Agent finished", hash: "#agents" },
			{ kind: "failed", title: "Agent failed" },
		]);
		expect(tracker.observe(undefined, feed(...next))).toEqual([]);
	});

	it("starts over for another session", () => {
		const tracker = new NoticeTracker();
		tracker.observe(snapshot({ awaiting: { kind: "approval", id: "d1" } }), feed(event(1, "agent.result")));
		const other = tracker.observe(snapshot({ sessionId: "t", awaiting: { kind: "approval", id: "d1" } }), {
			sessionId: "t",
			events: [event(1, "agent.result")],
		});
		expect(other).toMatchObject([{ kind: "approval" }]);
	});
});

describe("shouldNotify", () => {
	it("skips only a window that is visible and focused", () => {
		expect(shouldNotify({ visibilityState: "visible", hasFocus: () => true })).toBe(false);
		expect(shouldNotify({ visibilityState: "visible", hasFocus: () => false })).toBe(true);
		expect(shouldNotify({ visibilityState: "hidden", hasFocus: () => true })).toBe(true);
	});
});

describe("service worker source", () => {
	it("parses as a script and handles the notification click", () => {
		expect(() => new vm.Script(SERVICE_WORKER_JS)).not.toThrow();
		expect(SERVICE_WORKER_JS).toContain("notificationclick");
		expect(SERVICE_WORKER_JS).not.toMatch(/fetch\(|importScripts|https?:\/\//);
	});
});
