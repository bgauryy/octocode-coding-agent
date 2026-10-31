import { describe, expect, it, vi } from "vitest";
import type { ApplicationFrame } from "@octocodeai/octocode-contracts";
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
