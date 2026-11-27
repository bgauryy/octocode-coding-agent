/** @vitest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import { createBacklogStore } from "../src/app/extension.ts";
import { LiveProvider, useLive } from "../src/app/live/session.tsx";
import { FakeSocket } from "./helpers.ts";

function Probe() {
	const live = useLive();
	const application = useStore(live.session, (state) => state.application);
	const workspace = useStore(live.workspace, (state) => state.snapshot);
	return (
		<>
			<output>{`${application?.sessionId ?? "none"}/${workspace?.sessionId ?? "none"}/${workspace?.agents.length ?? 0}/${workspace?.events.map((event) => event.text).join(",") ?? ""}`}</output>
			<span data-testid="agents">{workspace?.agents.map((agent) => agent.status).join(",")}</span>
		</>
	);
}

function frame(sessionId: string) {
	return {
		protocolVersion: 1,
		cursor: { sessionId, epoch: `epoch-${sessionId}`, sequence: 0 },
		at: 10,
		type: "snapshot",
		snapshot: { sessionId, messages: [], streaming: false, steering: [], followUp: [], receipts: [], capabilities: [] },
	};
}

beforeEach(() => {
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

it("drops old workspace agents and events as soon as the application switches sessions", async () => {
	render(
		<LiveProvider
			access="test"
			backlog={createBacklogStore({
				repo: "test",
				generatedAt: 0,
				states: ["backlog", "todo", "ongoing", "done"],
				idleMs: 1,
				items: [],
			})}
		>
			<Probe />
		</LiveProvider>,
	);
	const socket = FakeSocket.instances[0];
	act(() => {
		socket.receive("workspace", {
			sessionId: "old",
			agents: [{ id: "old-agent" }],
			traffic: [],
			receipts: [],
			events: [{ id: 1, type: "message", at: 1, text: "old content" }],
		});
		socket.receive("application", frame("old"));
	});
	await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("old/old/1/old content"));
	act(() => socket.receive("application", frame("new")));
	await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("new/new/0/"));
	act(() =>
		socket.receive("workspace", {
			sessionId: "old",
			agents: [{ id: "stale-agent" }],
			traffic: [],
			receipts: [],
			events: [{ id: 2, type: "message", at: 2, text: "late old content" }],
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(screen.getByRole("status")).toHaveTextContent("new/new/0/");
	act(() =>
		socket.receive("workspace", {
			sessionId: "third",
			agents: [{ id: "new-agent" }],
			traffic: [],
			receipts: [],
			events: [],
		}),
	);
	expect(screen.getByRole("status")).toHaveTextContent("new/new/0/");
	act(() => socket.receive("application", frame("third")));
	await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("third/third/1/"));
});

it("resumes a sustained stream and keeps parallel tool and child-agent updates", async () => {
	render(
		<LiveProvider
			access="test"
			backlog={createBacklogStore({
				repo: "test",
				generatedAt: 0,
				states: ["backlog", "todo", "ongoing", "done"],
				idleMs: 1,
				items: [],
			})}
		>
			<Probe />
		</LiveProvider>,
	);
	const socket = FakeSocket.instances[0];
	const event = (sequence: number, value: object) => ({
		protocolVersion: 1,
		cursor: { sessionId: "s", epoch: "epoch-s", sequence },
		at: sequence,
		type: "event",
		event: value,
	});
	const workspace = (status: string) => ({
		sessionId: "s",
		agents: [{ id: "child", status }],
		traffic: [],
		receipts: [],
		events: [],
	});
	act(() => {
		socket.receive("workspace", workspace("working"));
		socket.receive("application", {
			...frame("s"),
			snapshot: {
				...frame("s").snapshot,
				streaming: true,
				runId: "run",
				messages: [{ id: "answer", role: "assistant", text: "", complete: false, order: 0 }],
				tools: [{ toolCallId: "tool", toolName: "bash", status: "running", text: "", order: 1 }],
			},
		});
		for (let sequence = 1; sequence <= 120; sequence++) {
			socket.receive(
				"application",
				event(sequence, {
					type: "message.delta",
					messageId: "answer",
					delta: ".",
					text: `progress ${sequence}`,
				}),
			);
		}
		socket.receive("workspace", workspace("working"));
	});
	await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("progress 120"));
	act(() => socket.close());
	await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
	const resumed = FakeSocket.instances[1];
	act(() => {
		resumed.receive("application", {
			...frame("s"),
			type: "resumed",
			cursor: { sessionId: "s", epoch: "epoch-s", sequence: 120 },
		});
		resumed.receive(
			"application",
			event(121, { type: "tool.completed", toolCallId: "tool", toolName: "bash", text: "passed" }),
		);
		resumed.receive(
			"application",
			event(122, {
				type: "message.completed",
				message: {
					id: "answer",
					role: "assistant",
					text: "Final answer",
					complete: true,
					order: 0,
				},
			}),
		);
		resumed.receive("workspace", workspace("settled"));
		socket.receive("application", event(123, { type: "message.delta", messageId: "answer", delta: "stale" }));
	});
	await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Final answer,bash passed"));
	expect(screen.getByRole("status")).not.toHaveTextContent("stale");
	expect(screen.getByTestId("agents")).toHaveTextContent("settled");
});

it("discards a stale workspace when the first application snapshot names a different session", async () => {
	render(
		<LiveProvider
			access="test"
			backlog={createBacklogStore({
				repo: "test",
				generatedAt: 0,
				states: ["backlog", "todo", "ongoing", "done"],
				idleMs: 1,
				items: [],
			})}
		>
			<Probe />
		</LiveProvider>,
	);
	act(() => {
		FakeSocket.instances[0].receive("workspace", {
			sessionId: "stale",
			agents: [{ id: "stale-agent" }],
			traffic: [],
			receipts: [],
			events: [{ id: 1, type: "message", at: 1, text: "old session" }],
		});
		FakeSocket.instances[0].receive("application", frame("current"));
	});
	await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("current/current/0/"));
	expect(screen.getByRole("status")).not.toHaveTextContent("old session");
});
