import { describe, expect, it, vi } from "vitest";
import type { ApplicationFrame, ApplicationPort } from "@octocodeai/octocode-contracts";
import { byAttention, SessionWatch } from "../../src/octocode/web-daemon/session-state.ts";
import { fakeSession } from "./web-daemon-fixture.ts";

const at = (sequence: number) => ({
	protocolVersion: 1 as const,
	cursor: { sessionId: "s", epoch: "e", sequence },
	at: 1,
});
const snapshot = (streaming: boolean, awaiting?: { kind: "approval"; title: string }): ApplicationFrame => ({
	...at(1),
	type: "snapshot",
	snapshot: {
		sessionId: "s",
		messages: [],
		streaming,
		steering: [],
		followUp: [],
		receipts: [],
		capabilities: [],
		...(awaiting ? { awaiting } : {}),
	},
});
const event = (sequence: number, body: Record<string, unknown>): ApplicationFrame =>
	({ ...at(sequence), type: "event", event: body }) as ApplicationFrame;

describe("session watch", () => {
	it("reports a frame it cannot read and reconnects instead of going quiet", async () => {
		const session = fakeSession("s");
		const report = vi.fn();
		const watch = new SessionWatch(session.workspace.application!, "s", () => {}, report);
		await vi.waitFor(() => expect(session.connects).toHaveLength(1));
		session.push({ ...at(1), type: "snapshot" } as unknown as ApplicationFrame);
		await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(session.connects).toHaveLength(2), { timeout: 3000 });
		session.push(snapshot(true));
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: true }));
		watch.close();
	});

	it("waits longer after each failed attempt, reports a repeated failure once, and starts over after a good stream", async () => {
		vi.useFakeTimers({ now: 0 });
		try {
			const unreadable = { ...at(1), type: "snapshot" } as unknown as ApplicationFrame;
			// Attempts 1 to 4 meet a frame that cannot be read, attempt 5 a good stream that ends, then unreadable again.
			const connects: number[] = [];
			const port = {
				connect: () => {
					connects.push(Date.now());
					const frames = connects.length === 5 ? [snapshot(false)] : [unreadable];
					return {
						async *[Symbol.asyncIterator]() {
							yield* frames;
						},
						execute: async () => ({ id: "x", status: "accepted" }),
						close: () => {},
					};
				},
			} as unknown as ApplicationPort;
			const report = vi.fn();
			const watch = new SessionWatch(port, "s", () => {}, report);
			await vi.advanceTimersByTimeAsync(20_000);
			watch.close();
			// Doubling waits while attempts fail, the short wait after a stream that ended normally, then doubling again.
			expect(connects.slice(0, 7).map((time, i) => time - (connects[i - 1] ?? 0))).toEqual([
				0, 1000, 2000, 4000, 8000, 1000, 1000,
			]);
			expect(connects[7] - connects[6]).toBe(2000);
			expect(report).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("knows nothing until the first snapshot, then follows runs and the dialog they block on", async () => {
		const session = fakeSession("s");
		const changes = vi.fn();
		const watch = new SessionWatch(session.workspace.application!, "s", changes);
		await vi.waitFor(() => expect(session.connects).toHaveLength(1));
		expect(watch.state).toBeUndefined();
		session.push(snapshot(true, { kind: "approval", title: "Run rm -rf build?" }));
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: true, needsYou: "Run rm -rf build?" }));
		session.push(event(2, { type: "session.awaiting" }));
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: true }));
		session.push(event(3, { type: "run.settled", runId: "r", outcome: "completed" }));
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: false }));
		session.push(event(4, { type: "run.started", runId: "r2" }));
		session.push(event(5, { type: "session.awaiting", awaiting: { kind: "question", title: "Branch?" } }));
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: true, needsYou: "Branch?" }));
		expect(changes).toHaveBeenCalledTimes(5);
		watch.close();
	});

	it("reports needsYou while no run is going, and keeps it through a run's start and end", async () => {
		const session = fakeSession("s");
		const watch = new SessionWatch(session.workspace.application!, "s", () => {});
		await vi.waitFor(() => expect(session.connects).toHaveLength(1));
		session.push(snapshot(false, { kind: "approval", title: "Subagent asks: run rm?" }));
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: false, needsYou: "Subagent asks: run rm?" }));
		session.push(event(2, { type: "run.started", runId: "r" }));
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: true, needsYou: "Subagent asks: run rm?" }));
		session.push(event(3, { type: "run.settled", runId: "r", outcome: "completed" }));
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: false, needsYou: "Subagent asks: run rm?" }));
		session.push(event(4, { type: "session.awaiting" }));
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: false }));
		session.push(event(5, { type: "session.awaiting", awaiting: { kind: "question", title: "Branch?" } }));
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: false, needsYou: "Branch?" }));
		watch.close();
	});

	it("stays busy after a run settles while the phase waits on background agents, until the phase is final", async () => {
		const session = fakeSession("s");
		const watch = new SessionWatch(session.workspace.application!, "s", () => {});
		await vi.waitFor(() => expect(session.connects).toHaveLength(1));
		session.push(snapshot(true));
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: true }));
		const waiting = { state: "waiting", agents: 4, queued: 0, bash: 0, external: 0 };
		session.push(event(2, { type: "session.phase", phase: waiting, jobStartedAt: 1 }));
		session.push(event(3, { type: "run.settled", runId: "r", outcome: "completed" }));
		session.push(event(4, { type: "session.awaiting", awaiting: { kind: "question", title: "Branch?" } }));
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: true, needsYou: "Branch?" }));
		session.push(event(5, { type: "session.awaiting" }));
		session.push(event(6, { type: "session.phase", phase: { state: "done" } }));
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: false }));
		watch.close();
	});

	it("reconnects after a resync while the session stays attached, and stops for good when closed", async () => {
		const session = fakeSession("s");
		const watch = new SessionWatch(session.workspace.application!, "s", () => {});
		await vi.waitFor(() => expect(session.connects).toHaveLength(1));
		session.push({ ...at(9), type: "resync", reason: "overflow" });
		await vi.waitFor(() => expect(session.connects).toHaveLength(2), { timeout: 3000 });
		watch.close();
		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(session.connects).toHaveLength(2);
	});

	it("forgets stale attention state while recovering a lost stream", async () => {
		const session = fakeSession("s");
		const changes = vi.fn();
		const watch = new SessionWatch(session.workspace.application!, "s", changes);
		try {
			session.push(snapshot(true, { kind: "approval", title: "Stale approval" }));
			await vi.waitFor(() => expect(watch.state?.needsYou).toBe("Stale approval"));
			session.push({ ...at(9), type: "resync", reason: "overflow" });
			await vi.waitFor(() => expect(watch.state).toBeUndefined());
			expect(changes).toHaveBeenCalledTimes(2);
			await vi.waitFor(() => expect(session.connects).toHaveLength(2), { timeout: 3000 });
			session.push(snapshot(false));
			await vi.waitFor(() => expect(watch.state).toEqual({ busy: false }));
		} finally {
			watch.close();
		}
	});

	it("orders sessions by attention: blocked first, then working, then idle, newest first within each", () => {
		const sessions = [
			{ id: "idle-new", startedAt: 5 },
			{ id: "busy", startedAt: 1, busy: true },
			{ id: "blocked-old", startedAt: 2, busy: true, needsYou: "Approve?" },
			{ id: "blocked-new", startedAt: 4, busy: true, needsYou: "Which?" },
			{ id: "idle-old", startedAt: 3, busy: false },
		];
		expect([...sessions].sort(byAttention).map((session) => session.id)).toEqual([
			"blocked-new",
			"blocked-old",
			"busy",
			"idle-new",
			"idle-old",
		]);
	});
});
