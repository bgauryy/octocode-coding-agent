/** @vitest-environment jsdom */
import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import type { Snapshot } from "@octocodeai/octocode-contracts/snapshot";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { daemonLive } from "../src/app/daemon/live.ts";
import { createBacklogStore } from "../src/app/extension.ts";
import { live } from "../src/app/live/index.ts";
import { FakeSocket, snapshotItem } from "./helpers.ts";

function task(
	seq: number,
	goal: string,
	owner: BacklogTask["owner"],
	overrides: Partial<BacklogTask> = {},
): BacklogTask {
	return {
		ref: `T${seq}`,
		seq,
		rowId: seq,
		goal,
		reason: "",
		state: "todo",
		position: seq - 1,
		owner,
		result: "",
		createdAt: 0,
		updatedAt: 0,
		version: 1,
		...overrides,
	};
}
const onB2 = { kind: "item", ref: "B2" } as const;
const snapshot: Snapshot = {
	repo: "repo",
	generatedAt: 1000,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 100_000,
	items: [
		snapshotItem("B1", {
			title: "Search epic",
			type: "epic",
			state: "backlog",
			epicState: "ongoing",
			children: ["B2"],
		}),
		snapshotItem("B2", {
			title: "Index files",
			type: "feature",
			state: "ongoing",
			parentId: "B1",
			tasks: [task(1, "Write the walker", onB2, { state: "done" }), task(2, "Add the cache", onB2)],
		}),
		snapshotItem("B3", { title: "Loose item", type: "feature", state: "todo" }),
	],
	sessionTasks: [task(3, "Check the flaky run", { kind: "session", id: "sess-9" })],
};

const fetchMock = vi.fn<typeof fetch>();
const posted = () =>
	fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function page(hash: string, scope: "session" | "repo" = "session") {
	history.replaceState(null, "", hash);
	if (!live) throw new Error("live extension");
	return render(
		<App backlog={createBacklogStore(snapshot)} live={daemonLive(live, { kind: scope, id: "x" })} access="tok" />,
	);
}

beforeEach(() => {
	FakeSocket.instances = [];
	fetchMock.mockReset().mockImplementation(async (_url, init) => json(init?.method === "POST" ? {} : snapshot));
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("epic → item → task tree", () => {
	it("shows the epic with its derived state and roll-up, the item with its tasks, and session tasks", () => {
		page("#tree");
		expect(screen.getByText("0 of 1 item done · 1 task open")).toBeInTheDocument();
		const epicLine = screen.getByRole("link", { name: "Search epic" }).closest(".item-line") as HTMLElement;
		expect(within(epicLine).getByRole("img", { name: "In progress" })).toBeInTheDocument();
		const tasks = screen.getByRole("list", { name: "Tasks of B2" });
		expect(within(tasks).getByText("Write the walker")).toBeInTheDocument();
		expect(within(tasks).getByText("Add the cache")).toBeInTheDocument();
		expect(screen.getByText("1 of 2 tasks done")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Session sess-9" })).toBeInTheDocument();
		expect(screen.getByText("Check the flaky run")).toBeInTheDocument();
	});

	it("adds a task under an item and an item under an epic", async () => {
		const user = userEvent.setup();
		page("#tree");
		await user.type(screen.getByRole("textbox", { name: "Add task to B2" }), "Handle symlinks{Enter}");
		await user.type(screen.getByRole("textbox", { name: "Add item to B1" }), "Rank results");
		await user.click(screen.getByRole("button", { name: "Add item" }));
		await waitFor(() => expect(posted()).toHaveLength(2));
		expect(posted()[0]).toEqual({ command: "task.add", goal: "Handle symlinks", item: "B2" });
		expect(posted()[1]).toMatchObject({ op: "add", title: "Rank results", parentId: "B1", type: "feature" });
	});

	it("changes a task's state and re-parents an item with the version it read", async () => {
		const user = userEvent.setup();
		page("#tree");
		await user.selectOptions(screen.getByRole("combobox", { name: "State of T2" }), "ongoing");
		await user.selectOptions(screen.getByRole("combobox", { name: "Epic of B3" }), "B1");
		await waitFor(() => expect(posted()).toHaveLength(2));
		expect(posted()[0]).toEqual({ command: "task.update", task: "T2", version: 1, state: "ongoing" });
		expect(posted()[1]).toEqual({ command: "item.reparent", id: "B3", version: 1, parentId: "B1" });
	});

	it("reorders tasks with buttons and with Alt+ArrowUp, and cannot move past the ends", async () => {
		const user = userEvent.setup();
		page("#tree");
		expect(screen.getByRole("button", { name: "Move T1 up" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Move T2 down" })).toBeDisabled();
		await user.click(screen.getByRole("button", { name: "Move T1 down" }));
		screen.getByRole("combobox", { name: "State of T2" }).focus();
		await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
		await waitFor(() => expect(posted()).toHaveLength(2));
		expect(posted()[0]).toEqual({ command: "task.move", task: "T1", version: 1, position: 1 });
		expect(posted()[1]).toEqual({ command: "task.move", task: "T2", version: 1, position: 0 });
	});

	it("promotes a session task", async () => {
		const user = userEvent.setup();
		page("#tree");
		await user.click(screen.getByRole("button", { name: "Promote T3 to an item" }));
		await waitFor(() => expect(posted()).toHaveLength(1));
		expect(posted()[0]).toEqual({ command: "task.promote", task: "T3", version: 1 });
	});

	it("shows the host's refusal next to the control and keeps what was typed", async () => {
		const user = userEvent.setup();
		fetchMock.mockImplementation(async (_url, init) =>
			init?.method === "POST" ? json({ error: "B2 is not an epic." }, 409) : json(snapshot),
		);
		page("#tree");
		await user.type(screen.getByRole("textbox", { name: "Add task to B3" }), "Another step{Enter}");
		expect(await screen.findByRole("alert")).toHaveTextContent("B2 is not an epic.");
		expect(screen.getByRole("textbox", { name: "Add task to B3" })).toHaveValue("Another step");
	});

	it("offers no edit control on a read-only repository page, but still shows the structure", () => {
		page("#tree", "repo");
		expect(screen.getByText("Add the cache")).toBeInTheDocument();
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(screen.queryByRole("button", { name: /Promote|Move T/ })).toBeNull();
	});
});

describe("board and item detail", () => {
	it("changes an item's state on its card, and sends closing to the editor", async () => {
		const user = userEvent.setup();
		page("#board");
		await user.selectOptions(screen.getByRole("combobox", { name: "State of B3" }), "backlog");
		await waitFor(() => expect(posted()).toHaveLength(1));
		expect(posted()[0]).toEqual({ command: "item.state", id: "B3", version: 1, state: "backlog" });
		await user.selectOptions(screen.getByRole("combobox", { name: "State of B3" }), "done");
		expect(location.hash).toBe("#B3/edit");
		expect(posted()).toHaveLength(1);
	});

	it("places an epic in the column of its derived state and gives it no stored-state control", () => {
		const { container } = page("#board");
		const column = (state: string) => container.querySelector(`section.column.state-${state}`) as HTMLElement;
		// B1 is stored as backlog but its item is ongoing: it sits with the ongoing items, not in the Backlog column.
		expect(within(column("ongoing")).getByRole("link", { name: "Search epic" })).toBeInTheDocument();
		expect(within(column("backlog")).queryByRole("link", { name: "Search epic" })).toBeNull();
		expect(screen.queryByRole("combobox", { name: "State of B1" })).toBeNull();
		expect(screen.getByRole("combobox", { name: "State of B2" })).toBeInTheDocument();
	});

	it("lists an item's tasks in its detail with an inline add", async () => {
		const user = userEvent.setup();
		page("#B2");
		const sheet = await screen.findByRole("dialog", { name: "Index files" });
		expect(within(sheet).getByRole("heading", { name: /Tasks/ })).toBeInTheDocument();
		await user.type(within(sheet).getByRole("textbox", { name: "Add a task to B2" }), "Document it{Enter}");
		await waitFor(() => expect(posted()).toEqual([{ command: "task.add", goal: "Document it", item: "B2" }]));
	});

	it("shows an epic's derived state and roll-up instead of task controls", async () => {
		page("#B1");
		const sheet = await screen.findByRole("dialog", { name: "Search epic" });
		expect(within(sheet).getByText(/derived from its items/)).toBeInTheDocument();
		expect(within(sheet).getByText("0 of 1 item done · 1 task open")).toBeInTheDocument();
		expect(within(sheet).queryByRole("textbox", { name: /Add a task/ })).toBeNull();
	});
});
