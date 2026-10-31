/** @vitest-environment jsdom */
import { Blob as NodeBlob } from "node:buffer";
import type { ReactNode } from "react";
import type { ApplicationActivity, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { act, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationStream } from "../src/application-stream.ts";
import { createBacklogStore } from "../src/app/extension.ts";
import { ApplicationProjection } from "../src/app/live/application-projection.ts";
import { HistoryPanel } from "../src/app/live/HistoryPanel.tsx";
import { ResultCard } from "../src/app/live/ResultCard.tsx";
import { LiveProvider } from "../src/app/live/session.tsx";
import { FakeSocket } from "./helpers.ts";

const snapshot: ApplicationSnapshot = {
	sessionId: "s",
	messages: [],
	tools: [],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: [],
};
function activity(id: string, extra: Partial<ApplicationActivity> = {}): ApplicationActivity {
	return { id, kind: "usage", at: 1, text: "Usage recorded", source: "session", data: { totalTokens: 24 }, ...extra };
}
function frame(sequence: number, body: object) {
	return { protocolVersion: 1, cursor: { sessionId: "s", epoch: "e", sequence }, at: sequence, ...body };
}
const requests: Array<{ url: string; init: RequestInit }> = [];
let responses: unknown[] = [];
beforeEach(() => {
	FakeSocket.instances = [];
	requests.length = 0;
	responses = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("Blob", NodeBlob);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit = {}) => {
			requests.push({ url: String(url), init });
			return new Response(JSON.stringify(responses.shift()), { status: 200 });
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());
function Wrapper({ children }: { children: ReactNode }) {
	return (
		<LiveProvider
			access="token"
			backlog={createBacklogStore({ repo: "r", generatedAt: 0, states: ["todo"], idleMs: 1, items: [] })}
		>
			{children}
		</LiveProvider>
	);
}
function announce(value: ApplicationSnapshot) {
	act(() => FakeSocket.instances[0].receive("application", frame(0, { type: "snapshot", snapshot: value })));
}

it("restores activities, upserts shell progress once, and keeps message and tool rows separate", () => {
	const stream = new ApplicationStream();
	const initial = {
		...snapshot,
		messages: [{ id: "m", role: "assistant", text: "Answer", complete: true }],
		activities: [
			activity("usage"),
			activity("shell", { kind: "bash", text: "Shell command\nStarted", source: "live" }),
		],
	};
	expect(stream.accept(frame(0, { type: "snapshot", snapshot: initial }))).toBe("applied");
	const projection = new ApplicationProjection();
	const first = projection.update(stream.snapshot, 0);
	expect(first.filter((event) => event.type === "message")).toHaveLength(1);
	expect(first.filter((event) => event.type === "session.activity")).toHaveLength(2);
	const update = activity("shell", { kind: "bash", text: "Shell command\nFinished", source: "live" });
	expect(stream.accept(frame(1, { type: "event", event: { type: "session.activity", activity: update } }))).toBe(
		"applied",
	);
	const second = projection.update(stream.snapshot, 1);
	expect(second.find((event) => event.activity?.id === "shell")?.id).toBe(
		first.find((event) => event.activity?.id === "shell")?.id,
	);
	expect(second.find((event) => event.activity?.id === "usage")).toBe(
		first.find((event) => event.activity?.id === "usage"),
	);
	expect(stream.snapshot?.activities).toHaveLength(2);
	const restored = new ApplicationStream();
	expect(restored.accept(frame(1, { type: "snapshot", snapshot: stream.snapshot }))).toBe("applied");
	expect(new ApplicationProjection().update(restored.snapshot, 1).map((event) => event.activity)).toEqual(
		second.map((event) => event.activity),
	);
});

it("bounds retained activity and replaces activity history on a branch reset", () => {
	const stream = new ApplicationStream();
	stream.accept(
		frame(0, {
			type: "snapshot",
			snapshot: { ...snapshot, activities: [activity("old")], activityBefore: "old", hasMoreActivities: true },
		}),
	);
	for (let sequence = 1; sequence <= 55; sequence++) {
		stream.accept(
			frame(sequence, { type: "event", event: { type: "session.activity", activity: activity(`a${sequence}`) } }),
		);
	}
	expect(stream.snapshot?.activities).toHaveLength(50);
	expect(stream.snapshot?.activities?.[0].id).toBe("a6");
	expect(stream.snapshot?.activityBefore).toBe("a6");
	expect(stream.snapshot?.hasMoreActivities).toBe(true);
	stream.accept(
		frame(56, {
			type: "event",
			event: { type: "session.reset", messages: [], tools: [], activities: [activity("branch")] },
		}),
	);
	expect(stream.snapshot?.activities?.map((item) => item.id)).toEqual(["branch"]);
	expect(stream.snapshot?.activityBefore).toBe("branch");
	expect(stream.snapshot?.hasMoreActivities).toBeUndefined();
	stream.accept(frame(57, { type: "event", event: { type: "session.reset", messages: [], tools: [] } }));
	expect(stream.snapshot?.activities).toEqual([]);
	expect(stream.snapshot?.activityBefore).toBeUndefined();
});

it("bounds activity payloads before and after reconnect without losing older-history access", () => {
	const activities = Array.from({ length: 20 }, (_, index) =>
		activity(`a${index}`, { data: { text: "x".repeat(3990) } }),
	);
	const stream = new ApplicationStream();
	stream.accept(frame(0, { type: "snapshot", snapshot: { ...snapshot, activities } }));
	expect(JSON.stringify(stream.snapshot?.activities).length).toBeLessThanOrEqual(32768);
	expect(stream.snapshot?.activities?.at(-1)?.id).toBe("a19");
	expect(stream.snapshot?.hasMoreActivities).toBe(true);
	stream.accept(
		frame(1, {
			type: "event",
			event: { type: "session.activity", activity: activity("a20", { data: { text: "x".repeat(3990) } }) },
		}),
	);
	expect(JSON.stringify(stream.snapshot?.activities).length).toBeLessThanOrEqual(32768);
	const reconnected = new ApplicationStream();
	reconnected.accept(frame(1, { type: "snapshot", snapshot: stream.snapshot }));
	expect(reconnected.snapshot).toEqual(stream.snapshot);
});

it("shows usage and shell details and reads complete shell output with session authentication", async () => {
	const full = { id: "shell-output", mimeType: "text/plain", size: 80 };
	const events = new ApplicationProjection().update(
		{
			...snapshot,
			activities: [
				activity("usage"),
				activity("shell", {
					kind: "bash",
					text: "Shell command\nPartial output",
					data: { command: "pwd", exitCode: 0 },
					full,
				}),
			],
		},
		1,
	);
	responses = [{ asset: full, encoding: "utf8", data: "Complete shell output\n/workspace/project" }];
	render(
		<>
			{events.map((event) => (
				<ResultCard key={event.id} event={event} />
			))}
		</>,
		{ wrapper: Wrapper },
	);
	expect(screen.getByRole("heading", { name: "Usage recorded" })).toBeInTheDocument();
	expect(screen.getByText(/"totalTokens": 24/)).toBeInTheDocument();
	expect(screen.getByText(/"command": "pwd"/)).toBeInTheDocument();
	await userEvent.click(screen.getByRole("button", { name: "Load full content" }));
	expect(await screen.findByText(/Complete shell output/)).toHaveTextContent("/workspace/project");
	expect(requests[0]).toMatchObject({
		url: "/api/application/assets/shell-output?sessionId=s",
		init: { headers: { Authorization: "Bearer token" } },
	});
});

it("loads full activity metadata without treating arbitrary data as a message or another asset reference", async () => {
	const full = { id: "details", mimeType: "application/json", size: 80 };
	const [event] = new ApplicationProjection().update({ ...snapshot, activities: [activity("usage", { full })] }, 1);
	responses = [
		{ asset: full, encoding: "utf8", data: JSON.stringify({ cost: 0.5, totalTokens: 1200, full: "data field" }) },
	];
	render(<ResultCard event={event} />, { wrapper: Wrapper });
	await userEvent.click(screen.getByRole("button", { name: "Load full details" }));
	expect(await screen.findByText(/"totalTokens": 1200/)).toHaveTextContent('"full": "data field"');
	expect(requests).toHaveLength(1);
	expect(screen.queryByRole("button", { name: "Load full details" })).toBeNull();
});

it("preserves role-specific message details alongside the displayed output", () => {
	const [event] = new ApplicationProjection().update(
		{
			...snapshot,
			messages: [
				{
					id: "shell-message",
					role: "bashExecution",
					complete: true,
					text: "Shell completed",
					content: [{ id: "text", type: "text", text: "Shell completed" }],
					details: { command: "pwd", exitCode: 0, cancelled: false, fullOutputPath: "/workspace/output.txt" },
				},
			],
		},
		1,
	);
	render(<ResultCard event={event} />, { wrapper: Wrapper });
	expect(screen.getByText("Shell completed")).toBeInTheDocument();
	expect(screen.getByText(/"exitCode": 0/)).toHaveTextContent('"fullOutputPath": "/workspace/output.txt"');
});

it("pages older activities independently and discards them when the branch resets", async () => {
	const initial = { ...snapshot, activities: [activity("recent")], activityBefore: "recent", hasMoreActivities: true };
	responses = [
		{
			messages: [{ id: "m", role: "assistant", text: "Unrelated message page", complete: true }],
			tools: [],
			hasMore: true,
			activities: [activity("older", { text: "Earlier usage" })],
			activityBefore: "older",
			hasMoreActivities: false,
		},
	];
	render(<HistoryPanel />, { wrapper: Wrapper });
	announce(initial);
	await userEvent.click(screen.getByRole("button", { name: "Load earlier session updates" }));
	expect(await screen.findByRole("heading", { name: "Earlier usage" })).toBeInTheDocument();
	expect(screen.queryByText("Unrelated message page")).toBeNull();
	expect(screen.queryByRole("heading", { name: "Usage recorded" })).toBeNull();
	expect(requests[0].url).toBe("/api/application/history?sessionId=s&limit=50&activityBefore=recent");
	expect(screen.getByRole("button", { name: "Load earlier messages" })).toBeInTheDocument();
	act(() =>
		FakeSocket.instances[0].receive(
			"application",
			frame(1, { type: "event", event: { type: "session.reset", messages: [], tools: [], activities: [] } }),
		),
	);
	expect(screen.queryByRole("heading", { name: "Earlier usage" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Load earlier session updates" })).toBeNull();
});
