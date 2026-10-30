/** @vitest-environment jsdom */
import type { ApplicationSnapshot } from "@octocodeai/octocode-contacts";
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActivityView } from "../src/app/live/ActivityView.tsx";
import { AgentsView } from "../src/app/live/AgentsView.tsx";
import { SessionComposer } from "../src/app/live/SessionComposer.tsx";
import { indexBacklog } from "../src/app/model/backlog.ts";
import { controlView, deferredControl, posted, setupControls } from "./control-fixtures.tsx";
import { FakeSocket } from "./helpers.ts";

beforeEach(setupControls);
afterEach(() => vi.unstubAllGlobals());

const index = indexBacklog({
	repo: "r",
	generatedAt: 0,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 1,
	items: [],
});
const activity = () => <ActivityView index={index} params={{}} setParams={() => {}} />;
const running = { streaming: true, runId: "run-1" };

it("labels the feed and run indicator as cached while reconnecting, never as live", async () => {
	const view = controlView(activity());
	await view.workspace();
	await view.session(running);
	expect(screen.getByText(/^Live · 0 events/)).toBeInTheDocument();
	expect(screen.queryByText("last known")).toBeNull();

	act(() => FakeSocket.instances[0].close(1006));
	expect(screen.getByText(/Reconnecting · showing cached feed/)).toBeInTheDocument();
	expect(screen.queryByText(/^Live/)).toBeNull();
	expect(screen.getByText("last known")).toBeInTheDocument();
	expect(screen.getByText("Running · last known")).toBeInTheDocument();
});

it("says the feed is disconnected once the access has expired", async () => {
	const view = controlView(activity());
	await view.workspace();
	await view.session(running);
	view.disconnect();
	expect(screen.getByText(/Disconnected · showing cached feed/)).toBeInTheDocument();
	expect(screen.queryByText(/^Live/)).toBeNull();
	expect(screen.getByText("last known")).toBeInTheDocument();
});

it("shows an error with a reload action, not a loading skeleton, when the first connection fails", async () => {
	const view = controlView(activity());
	expect(screen.getByRole("status", { name: "Connecting to the session" })).toBeInTheDocument();
	view.disconnect();
	expect(screen.getByText("Can't reach the session")).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Reload page" })).toBeInTheDocument();
	expect(screen.queryByRole("status", { name: "Connecting to the session" })).toBeNull();
	view.show(<AgentsView />);
	expect(screen.getByText("Can't reach the session")).toBeInTheDocument();
});

it("keeps the connecting skeleton while a reconnect is still being attempted", async () => {
	const view = controlView(<AgentsView />);
	act(() => FakeSocket.instances[0].close(1006));
	expect(screen.getByRole("status", { name: "Connecting to the session" })).toBeInTheDocument();
	expect(screen.queryByText("Can't reach the session")).toBeNull();
	view.disconnect();
});

it.each([
	["compacting", "Compacting context", "Compacting"],
	["retrying", "Retrying request", "Retrying"],
])("shows %s as a phase of its own, not as idle", async (status, phase, badge) => {
	const view = controlView(activity());
	await view.workspace();
	await view.session({ status: status as "compacting" | "retrying" });
	expect(screen.getByText(phase)).toBeInTheDocument();
	expect(screen.getByText(badge)).toBeInTheDocument();
	expect(screen.queryByText("Idle")).toBeNull();
	await view.session({ status: "idle" });
	expect(screen.queryByText(phase)).toBeNull();
	expect(screen.getByText("Idle")).toBeInTheDocument();
});

it("says the run is waiting for the user while a dialog is open, and only then", async () => {
	const view = controlView(activity());
	await view.workspace();
	await view.session({ ...running, awaiting: { kind: "approval", title: "Run rm -rf build?" } });
	expect(screen.getByText("Waiting for you in the terminal: Run rm -rf build?")).toBeInTheDocument();
	expect(screen.getByText("Waiting for you")).toBeInTheDocument();
	await view.session({ ...running });
	expect(screen.queryByText(/Waiting for you/)).toBeNull();
	expect(screen.getByText("Thinking")).toBeInTheDocument();
	expect(screen.getByText("Running")).toBeInTheDocument();
});

it("lets the user answer an answerable dialog from the page, and says so instead of pointing at the terminal", async () => {
	const view = controlView(activity());
	await view.workspace();
	await view.session({
		...running,
		capabilities: ["prompt", "steer", "followUp", "abort", "answer"],
		awaiting: {
			kind: "approval",
			title: "Run rm -rf build?",
			id: "d1",
			options: ["Allow once", "Deny"],
			allowsText: false,
		},
	});
	expect(screen.getByText("Waiting for you: Run rm -rf build?")).toBeInTheDocument();
	expect(screen.queryByText(/Waiting for you in the terminal/)).toBeNull();
	await userEvent.click(screen.getByRole("button", { name: "Allow once" }));
	await waitFor(() =>
		expect(posted().at(-1)).toMatchObject({ action: "answer", dialogId: "d1", choice: "Allow once" }),
	);
	await view.session({
		...running,
		capabilities: ["prompt", "steer", "followUp", "abort", "answer"],
		awaiting: { kind: "question", title: "Branch name?", id: "d2", options: [], allowsText: true },
	});
	await userEvent.type(screen.getByRole("textbox", { name: "Your answer" }), "feature/remote");
	await userEvent.click(screen.getByRole("button", { name: "Answer" }));
	await waitFor(() =>
		expect(posted().at(-1)).toMatchObject({ action: "answer", dialogId: "d2", text: "feature/remote" }),
	);
});

it("keeps keyboard focus in the message box while a message is sent", async () => {
	const finish = deferredControl();
	const view = controlView(<SessionComposer />);
	await view.workspace();
	await view.session();
	const box = screen.getByRole("textbox", { name: "Message" });
	await userEvent.type(box, "Guide the agent");
	await userEvent.keyboard("{Control>}{Enter}{/Control}");
	expect(box).toHaveAttribute("readonly");
	expect(box).not.toBeDisabled();
	expect(box).toHaveFocus();
	await act(async () => finish());
	await waitFor(() => expect(box).not.toHaveAttribute("readonly"));
	expect(box).toHaveFocus();
	await userEvent.type(box, "Another");
	expect(box).toHaveValue("Another");
});

it("does not drop focus to the page after sending with the Send button", async () => {
	const finish = deferredControl();
	const view = controlView(<SessionComposer />);
	await view.workspace();
	await view.session();
	const box = screen.getByRole("textbox", { name: "Message" });
	await userEvent.type(box, "Click to send");
	await userEvent.click(screen.getByRole("button", { name: "Send" }));
	await act(async () => finish());
	await waitFor(() => expect(box).not.toHaveAttribute("readonly"));
	expect(document.body).not.toHaveFocus();
});

it("marks a tool group by its outcome: stopped when nothing ran, and failures stay visible while it still runs", async () => {
	const tool = (
		toolCallId: string,
		extra: { status: "running" | "completed" | "failed"; notRun?: true },
	): NonNullable<ApplicationSnapshot["tools"]>[number] => ({ toolCallId, toolName: "read", text: "", ...extra });
	const view = controlView(activity());
	await view.workspace();
	await view.session({
		tools: [tool("a", { status: "failed", notRun: true }), tool("b", { status: "failed", notRun: true })],
	});
	const summary = () => document.querySelector(".tool-group > summary")!;
	expect(summary().querySelector(".mark-stopped")).not.toBeNull();
	expect(summary().querySelector(".mark-done")).toBeNull();
	await view.session({
		streaming: true,
		runId: "run-1",
		tools: [tool("a", { status: "failed" }), tool("b", { status: "running" })],
	});
	expect(summary().querySelector(".mark-running")).not.toBeNull();
	expect(summary()).toHaveTextContent("Running · 1/2 done · 1 failed");
});
