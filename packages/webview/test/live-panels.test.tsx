/** @vitest-environment jsdom */
import type { BacklogAudit, Snapshot, SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import type { WorkspaceSnapshot } from "@octocodeai/octocode-contracts/workspace";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { ActivityView } from "../src/app/live/ActivityView.tsx";
import { AuditView } from "../src/app/live/AuditView.tsx";
import { CommandButton, MessageForm } from "../src/app/live/controls.tsx";
import { ItemActivity } from "../src/app/live/ItemPanels.tsx";
import { LiveProvider } from "../src/app/live/session.tsx";
import { indexBacklog } from "../src/app/model/backlog.ts";
import { LongText, RichTextContext } from "../src/app/ui/LongText.tsx";
import { FakeSocket, snapshotItem } from "./helpers.ts";

const backlog: Snapshot = {
	repo: "repo",
	generatedAt: 0,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 1,
	items: [],
};
function item(ref: string, overrides: Partial<SnapshotItem> = {}): SnapshotItem {
	return snapshotItem(ref, {
		state: "todo",
		version: 3,
		goal: "Fix the issue",
		why: "Users are blocked",
		...overrides,
	});
}
function workspace(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
	return { sessionId: "s", agents: [], traffic: [], events: [], receipts: [], ...overrides };
}
function member(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		role: "general",
		pid: 1,
		status: "idle",
		joinedAt: 0,
		updatedAt: 0,
		toolCalls: 2,
		input: 100,
		cacheRead: 0,
		output: 50,
		cost: 0.5,
		unpriced: false,
		...overrides,
	};
}

type Reply = { status?: number; body: unknown } | Error;
let replies: Reply[] = [];
const requests: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

beforeEach(() => {
	FakeSocket.instances = [];
	replies = [];
	requests.length = 0;
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init: RequestInit = {}) => {
			requests.push({
				url: String(url),
				method: init.method ?? "GET",
				body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
			});
			const reply = replies.shift() ?? { body: {} };
			if (reply instanceof Error) throw reply;
			const payload = requests.at(-1)?.body;
			const body =
				reply.body && typeof reply.body === "object" && "receipt" in reply.body
					? {
							...reply.body,
							receipt: {
								...(reply.body.receipt as object),
								id: payload?.id,
								action: payload?.action,
								backlogId: payload?.backlogId,
								at: 0,
							},
						}
					: reply.body;
			return new Response(JSON.stringify(body), { status: reply.status ?? 200 });
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());

function renderLive(children: ReactNode) {
	const result = render(
		<LiveProvider access="token" backlog={createBacklogStore(backlog)}>
			{children}
		</LiveProvider>,
	);
	return { ...result, socket: FakeSocket.instances[0] };
}
async function pushWorkspace(socket: FakeSocket, snapshot: WorkspaceSnapshot) {
	act(() => socket.receive("workspace", snapshot));
	// The provider coalesces updates into one per frame (or 100 ms).
	await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
}
const commandRequests = () => requests.filter((request) => request.url === "/api/workspace");

describe("LongText", () => {
	it("renders short text as a literal block without a disclosure", () => {
		const { container } = render(<LongText text="short" label="output" />);
		expect(screen.getByText("short").tagName).toBe("PRE");
		expect(container.querySelector("details")).toBeNull();
	});

	it("folds text over 14 lines into a closed disclosure that names its size", () => {
		const text = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
		const { container } = render(<LongText text={text} label="output" />);
		const details = container.querySelector("details")!;
		expect(details.open).toBe(false);
		expect(within(details).getByText(`output: 20 lines, ${text.length} characters`)).toBeInTheDocument();
	});

	it("opens rich text on demand and keeps plain output literal", async () => {
		const Rich = ({ text }: { text: string }) => <article aria-label="rich">{text.toUpperCase()}</article>;
		const long = "x".repeat(800);
		const { container, rerender } = render(
			<RichTextContext.Provider value={Rich}>
				<LongText text={long} label="message" />
			</RichTextContext.Provider>,
		);
		expect(container.querySelector("details")?.open).toBe(false);
		expect(container.querySelector("article")).toBeNull();
		await userEvent.click(screen.getByText(/message: 1 line/));
		expect(await screen.findByRole("article", { name: "rich" })).toHaveTextContent("X".repeat(800));
		rerender(
			<RichTextContext.Provider value={Rich}>
				<LongText text="tool output" label="output" plain />
			</RichTextContext.Provider>,
		);
		expect(screen.queryByRole("article", { name: "rich" })).toBeNull();
		expect(screen.getByText("tool output").tagName).toBe("PRE");
	});
});

describe("CommandButton", () => {
	it("is disabled with an explanation for done and claimed items and sends nothing", async () => {
		renderLive(
			<>
				<CommandButton label="Work done" action="work" item={item("B1", { state: "done" })} />
				<CommandButton label="Work ongoing" action="work" item={item("B2", { state: "ongoing" })} />
			</>,
		);
		expect(screen.getByRole("button", { name: "Work done" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Work ongoing" })).toBeDisabled();
		expect(screen.getByText("Reopen the item to start more work.")).toBeInTheDocument();
		expect(screen.getByText("Already claimed. Message the agent to follow up.")).toBeInTheDocument();
		expect(commandRequests()).toEqual([]);
	});

	it("retries a network failure with the same request id, then locks after acceptance", async () => {
		replies = [new Error("offline"), { body: { receipt: { id: "x", status: "accepted", message: "Started" } } }];
		renderLive(<CommandButton label="Work" action="work" item={item("B7")} />);
		const button = screen.getByRole("button", { name: "Work" });
		await userEvent.click(button);
		expect(await screen.findByText(/offline Retry checks the same request/)).toBeInTheDocument();
		await userEvent.click(button);
		expect(await screen.findByText("Started")).toBeInTheDocument();
		expect(button).toBeDisabled();
		const [first, second] = commandRequests();
		expect(first.body).toMatchObject({ action: "work", backlogId: "B7", version: 3 });
		expect(second.body?.id).toBe(first.body?.id);
	});

	it("uses a new request id after a failed receipt and stays enabled", async () => {
		replies = [
			{ body: { receipt: { id: "x", status: "failed", message: "Busy" } } },
			{ body: { receipt: { id: "y", status: "accepted", message: "Stopping" } } },
		];
		renderLive(<CommandButton label="Stop" action="stop" to="agent-1" />);
		const button = screen.getByRole("button", { name: "Stop" });
		await userEvent.click(button);
		expect(await screen.findByText("Busy")).toBeInTheDocument();
		expect(button).toBeEnabled();
		await userEvent.click(button);
		await screen.findByText("Stopping");
		const [first, second] = commandRequests();
		expect(first.body).toMatchObject({ action: "stop", to: "agent-1" });
		expect(first.body).not.toHaveProperty("backlogId");
		expect(second.body?.id).not.toBe(first.body?.id);
	});
});

describe("MessageForm", () => {
	it("asks for a recipient and text instead of sending an incomplete message", () => {
		const { container } = renderLive(<MessageForm />);
		fireEvent.submit(container.querySelector("form")!);
		expect(screen.getByText("Choose an agent and write a message.")).toBeInTheDocument();
		expect(commandRequests()).toEqual([]);
	});

	it("sends an item message with its ref and version and clears the draft once accepted", async () => {
		replies = [{ body: { receipt: { id: "x", status: "accepted", message: "Delivered" } } }];
		const { socket } = renderLive(<MessageForm item={item("B4")} />);
		await pushWorkspace(socket, workspace({ agents: [member("agent-1"), member("agent-2")] as never }));
		const box = screen.getByRole("textbox", { name: "Message" });
		await userEvent.type(box, "Please review");
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Recipient" }), "agent-2");
		await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
		expect(await screen.findByText("Delivered")).toBeInTheDocument();
		expect(box).toHaveValue("");
		expect(commandRequests().map((request) => request.body)).toEqual([
			expect.objectContaining({ action: "message", to: "agent-2", text: "Please review", backlogId: "B4", version: 3 }),
		]);
	});

	it("keeps the text after a failed receipt and retries under a new id", async () => {
		replies = [
			{ body: { receipt: { id: "x", status: "failed", message: "Agent gone" } } },
			{ body: { receipt: { id: "y", status: "accepted", message: "Delivered" } } },
		];
		const { socket } = renderLive(<MessageForm agentId="agent-1" />);
		await pushWorkspace(socket, workspace({ agents: [member("agent-1")] as never }));
		const box = screen.getByRole("textbox", { name: "Message" });
		await userEvent.type(box, "Hello");
		expect(screen.getByRole("combobox", { name: "Recipient" })).toHaveValue("agent-1");
		await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
		expect(await screen.findByText("Agent gone")).toBeInTheDocument();
		expect(box).toHaveValue("Hello");
		await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
		expect(await screen.findByText("Delivered")).toBeInTheDocument();
		expect(box).toHaveValue("");
		const [first, second] = commandRequests();
		expect(first.body).toMatchObject({ action: "message", to: "agent-1", text: "Hello" });
		expect(second.body?.id).not.toBe(first.body?.id);
	});
});

describe("AuditView", () => {
	const audit = (id: number, overrides: Partial<BacklogAudit> = {}): BacklogAudit => ({
		id,
		backlogId: "B1",
		at: 0,
		actor: { id: "kim" },
		action: "update",
		entity: "backlog",
		before: { title: "Old", state: "todo" },
		after: { title: "New", state: "todo" },
		...overrides,
	});
	const view = (params: Record<string, string> = {}) => (
		<AuditView index={indexBacklog(backlog)} params={params} setParams={() => {}} />
	);

	it("lists entries newest first and shows only the fields that changed", async () => {
		replies = [{ body: { events: [audit(1), audit(2, { action: "delete", entity: "backlog_comments" })] } }];
		renderLive(view());
		expect(screen.getByRole("heading", { name: "Workspace audit" })).toBeInTheDocument();
		await screen.findByText(/Comment removed/);
		const summaries = [...document.querySelectorAll("summary")].map((summary) => summary.textContent);
		expect(summaries[0]).toContain("Comment removed");
		expect(summaries[1]).toContain("Item changed");
		const changed = [...document.querySelectorAll(".audit-entry")][1];
		expect([...changed.querySelectorAll("dt")].map((term) => term.textContent)).toEqual(["title"]);
		expect(requests[0].url).toBe("/api/audit?");
	});

	it("filters by item, loads older pages with the server's cursor and appends them", async () => {
		replies = [{ body: { events: [audit(5)], before: 5 } }, { body: { events: [audit(3, { backlogId: "B1" })] } }];
		renderLive(view({ backlogId: "B1" }));
		expect(screen.getByRole("heading", { name: "Audit for B1" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Show the whole workspace" })).toHaveAttribute("href", "#audit");
		await userEvent.click(await screen.findByRole("button", { name: "Load older events" }));
		await waitFor(() => expect(document.querySelectorAll(".audit-entry")).toHaveLength(2));
		expect(requests.map((request) => request.url)).toEqual([
			"/api/audit?backlogId=B1",
			"/api/audit?before=5&backlogId=B1",
		]);
		expect(screen.queryByRole("button", { name: "Load older events" })).toBeNull();
	});

	it("shows the server's error as an alert and an empty history as an empty state", async () => {
		replies = [{ status: 403, body: { error: "Access denied" } }];
		const { unmount } = renderLive(view());
		expect(await screen.findByRole("alert")).toHaveTextContent("Access denied");
		unmount();
		replies = [{ body: { events: [] } }];
		renderLive(view());
		expect(await screen.findByText("No changes recorded yet")).toBeInTheDocument();
	});
});

describe("ItemActivity audit history", () => {
	it("reads the item's history from the audit route only when its panel opens", async () => {
		const event: BacklogAudit = {
			id: 9,
			backlogId: "B2",
			at: 0,
			actor: { id: "user" },
			action: "update",
			entity: "backlog",
			before: { title: "Old" },
			after: { title: "New" },
		};
		renderLive(<ItemActivity item={item("B2")} />);
		const panel = screen.getByText("Audit history").closest("details")!;
		// The board snapshot carries no audit rows, and a closed panel asks for none.
		expect(requests.filter((request) => request.url.startsWith("/api/audit"))).toEqual([]);
		replies = [{ body: { events: [event] } }];
		// Opening a <details> fires its toggle event, as a click on the summary would.
		panel.open = true;
		fireEvent(panel, new Event("toggle"));
		await within(panel).findByText(/Item changed/);
		expect(within(panel).getByText("Audit history (1 recent events)")).toBeInTheDocument();
		expect(requests.map((request) => request.url)).toContain("/api/audit?backlogId=B2");
	});
});

describe("ItemActivity comments", () => {
	it("posts a comment with the item version, clears it and reloads the board", async () => {
		replies = [{ body: { item: item("B2") } }, { body: backlog }];
		renderLive(<ItemActivity item={item("B2", { version: 7 })} />);
		await userEvent.type(screen.getByRole("textbox", { name: "Comment" }), "Looks good");
		await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
		await waitFor(() => expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue(""));
		expect(requests.map((request) => [request.method, request.url])).toEqual([
			["POST", "/api/backlogs"],
			["GET", "/api/backlogs"],
		]);
		expect(requests[0].body).toEqual({ op: "comment", id: "B2", version: 7, note: "Looks good" });
	});

	it("keeps the comment and explains the failure when saving fails", async () => {
		replies = [{ status: 409, body: { error: "Version conflict." } }];
		renderLive(<ItemActivity item={item("B2")} />);
		await userEvent.type(screen.getByRole("textbox", { name: "Comment" }), "Draft");
		await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
		expect(await screen.findByText("Version conflict. Your comment is still here.")).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Draft");
	});

	it("distinguishes a saved comment from a failed board refresh", async () => {
		replies = [{ body: { item: item("B2") } }, new Error("Connection lost.")];
		renderLive(<ItemActivity item={item("B2")} />);
		await userEvent.type(screen.getByRole("textbox", { name: "Comment" }), "Saved context");
		await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
		expect(await screen.findByText("Comment saved. Connection lost. Refresh the board to see it.")).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("");
	});

	it("offers agent controls only once the session's workspace is connected", async () => {
		const { socket } = renderLive(<ItemActivity item={item("B2")} />);
		expect(screen.getByText(/Agent controls connect when this board is opened/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Request new agent" })).toBeNull();
		await pushWorkspace(
			socket,
			workspace({
				receipts: [
					{ id: "r1", backlogId: "B2", action: "work", status: "failed", at: 0, message: "No agent free" },
					{ id: "r2", backlogId: "B9", action: "work", status: "accepted", at: 0, message: "Other item" },
				],
			}),
		);
		expect(screen.getByRole("button", { name: "Request new agent" })).toBeInTheDocument();
		const receipts = screen.getByRole("list", { name: "Requests for this item" });
		expect(
			within(receipts)
				.getAllByRole("listitem")
				.map((entry) => entry.textContent),
		).toEqual(["failedNo agent free"]);
	});
});

describe("a live view with no session", () => {
	afterEach(() => vi.useRealTimers());

	it.each([["Activity", () => <ActivityView index={indexBacklog(backlog)} params={{}} setParams={() => {}} />]])(
		"%s says Connecting for about 5 s, then explains there is no session",
		(_name, view) => {
			vi.useFakeTimers();
			renderLive(view());
			expect(screen.getByRole("status", { name: "Connecting to the session" })).toBeInTheDocument();
			act(() => {
				vi.advanceTimersByTime(4900);
			});
			expect(screen.getByRole("status", { name: "Connecting to the session" })).toBeInTheDocument();
			act(() => {
				vi.advanceTimersByTime(200);
			});
			expect(screen.queryByRole("status", { name: "Connecting to the session" })).toBeNull();
			expect(screen.getByText("No session")).toBeInTheDocument();
			expect(screen.getByText(/Open \/(web|backlog) from a running Octocode session/)).toBeInTheDocument();
			expect(screen.getByText(/keeps trying to connect/)).toBeInTheDocument();
		},
	);
});
