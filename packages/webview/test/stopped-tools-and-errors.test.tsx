/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import type { ApplicationSnapshot } from "@octocodeai/octocode-contacts";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { ApplicationProjection, type FeedEvent } from "../src/app/live/application-projection.ts";
import { activityCard, groupFeed, terminalEntries } from "../src/app/live/model.ts";
import { ResultCard } from "../src/app/live/ResultCard.tsx";
import { LiveProvider } from "../src/app/live/session.tsx";
import { FakeSocket } from "./helpers.ts";

const base: ApplicationSnapshot = {
	sessionId: "s",
	messages: [],
	tools: [],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: [],
};
beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
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
const project = (patch: Partial<ApplicationSnapshot>) => new ApplicationProjection().update({ ...base, ...patch }, 1);

it("shows a tool that did not run as neutral, not failed, and counts it apart from failures in a group", () => {
	const events = project({
		tools: [
			{ toolCallId: "a", toolName: "read", text: "Not run: the model response failed", status: "failed", notRun: true },
			{ toolCallId: "b", toolName: "bash", text: "boom", status: "failed" },
			{ toolCallId: "c", toolName: "grep", text: "ok", status: "completed" },
		],
	});
	const [notRun, failed] = events.map((event) => activityCard(event));
	expect(notRun).toMatchObject({ failed: false, tone: "neutral", label: "Not run", status: "not run" });
	expect(failed).toMatchObject({ failed: true, tone: "danger" });
	const [group] = groupFeed(events);
	expect(group.kind === "tools" && group.summary).toEqual({ total: 3, running: 0, failed: 1, done: 3, notRun: 1 });
	expect(terminalEntries(events).map((entry) => entry.status)).toEqual(["not run", "failed", "done"]);
});

it("shows a failed session activity as failed", () => {
	const [event] = project({
		activities: [
			{
				id: "a",
				kind: "compaction_end",
				at: 1,
				text: "Compaction failed: provider down",
				source: "live",
				outcome: "failed",
			},
		],
	});
	expect(activityCard(event)).toMatchObject({
		failed: true,
		tone: "danger",
		title: "Compaction failed: provider down",
	});
});

it("keeps the rest of the feed alive when one result card throws, and names the error", () => {
	const spy = vi.spyOn(console, "error").mockImplementation(() => {});
	const bad = {
		id: 1,
		at: 1,
		type: "message",
		text: "x",
		message: {
			id: "m",
			role: "assistant",
			text: "x",
			complete: true,
			get content(): never {
				throw new Error("bad row");
			},
		},
	} as unknown as FeedEvent;
	const [good] = project({ messages: [{ id: "g", role: "assistant", text: "Healthy answer", complete: true }] });
	render(
		<>
			<ResultCard event={bad} />
			<ResultCard event={good} />
		</>,
		{ wrapper: Wrapper },
	);
	expect(screen.getByRole("alert")).toHaveTextContent("bad row");
	expect(screen.getByText("Healthy answer")).toBeInTheDocument();
	spy.mockRestore();
});

it("marks results with the shared run-state shapes: stopped for not-run and cut-short replies, failed for failures", () => {
	const events = project({
		messages: [{ id: "m", role: "assistant", text: "Partial answer", complete: true, status: "aborted" }],
		tools: [
			{ toolCallId: "a", toolName: "read", text: "Not run: the model response failed", status: "failed", notRun: true },
			{ toolCallId: "b", toolName: "bash", text: "boom", status: "failed" },
			{ toolCallId: "c", toolName: "grep", text: "ok", status: "completed" },
		],
	});
	const { container } = render(
		<Wrapper>
			{events.map((event) => (
				<ResultCard key={event.id} event={event} />
			))}
		</Wrapper>,
	);
	const marks = (name: string) => container.querySelectorAll(`.result-meta .mark-${name}`).length;
	expect([marks("stopped"), marks("failed"), marks("done")]).toEqual([2, 1, 1]);
	expect(screen.getByText("Stopped")).toBeInTheDocument();
});
