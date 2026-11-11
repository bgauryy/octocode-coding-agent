/** @vitest-environment jsdom */
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { LiveProvider, useLive } from "../src/app/live/session.tsx";
import { FakeSocket } from "./helpers.ts";

beforeEach(() => {
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function mount() {
	let live!: ReturnType<typeof useLive>;
	function Capture() {
		const source = useLive();
		useEffect(() => {
			live = source;
		}, [source]);
		return null;
	}
	render(
		<LiveProvider
			access="token"
			backlog={createBacklogStore({ repo: "r", generatedAt: 0, states: ["todo"], idleMs: 1, items: [] })}
		>
			<Capture />
		</LiveProvider>,
	);
	return () => live;
}

const snapshot = (sessionId: string) => ({
	protocolVersion: 1,
	cursor: { sessionId, epoch: sessionId, sequence: 0 },
	at: 1,
	type: "snapshot",
	snapshot: {
		sessionId,
		streaming: true,
		runId: "run",
		messages: [{ id: "answer", role: "assistant", text: "", complete: false, order: 0 }],
		steering: [],
		followUp: [],
		receipts: [],
		capabilities: [],
	},
});
const delta = (sequence: number) => ({
	protocolVersion: 1,
	cursor: { sessionId: "s", epoch: "s", sequence },
	at: 1 + sequence,
	type: "event",
	event: { type: "message.delta", messageId: "answer", delta: ".", text: `progress ${sequence}` },
});

it("coalesces application deltas into one session update per frame and applies a session switch at once", () => {
	const live = mount();
	act(() => FakeSocket.instances[0].receive("application", snapshot("s")));
	const session = live().session;
	expect(session.getState().application?.sessionId).toBe("s");
	let updates = 0;
	const unsubscribe = session.subscribe((state, previous) => {
		if (state.application !== previous.application) updates++;
	});
	act(() => {
		for (let sequence = 1; sequence <= 50; sequence++) FakeSocket.instances[0].receive("application", delta(sequence));
	});
	expect(updates).toBe(0);
	expect(session.getState().application?.messages[0].text).toBe("");
	act(() => vi.advanceTimersByTime(101));
	expect(updates).toBe(1);
	expect(session.getState().application?.messages[0].text).toBe("progress 50");
	expect(
		live()
			.workspace.getState()
			.snapshot?.events.map((event) => event.text),
	).toEqual(["progress 50"]);

	// A session switch must not wait for the frame: the new composer becomes usable immediately.
	act(() => FakeSocket.instances[0].receive("application", snapshot("t")));
	expect(updates).toBe(2);
	expect(session.getState().application?.sessionId).toBe("t");
	expect(live().workspace.getState().snapshot?.sessionId).toBe("t");
	unsubscribe();
});
