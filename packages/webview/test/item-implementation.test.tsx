/** @vitest-environment jsdom */
import type { Snapshot, SnapshotItem } from "@octocodeai/octocode-contacts/snapshot";
import type { WorkspaceSnapshot } from "@octocodeai/octocode-contacts/workspace";
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { ItemImplementation, ItemQuickAction } from "../src/app/live/ItemImplementation.tsx";
import { ItemActions, ItemActivity } from "../src/app/live/ItemPanels.tsx";
import { LiveProvider } from "../src/app/live/session.tsx";
import { FakeSocket, snapshotItem } from "./helpers.ts";

const backlog: Snapshot = {
	repo: "repo",
	generatedAt: 0,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 1,
	items: [],
};
const ready = (overrides: Partial<SnapshotItem> = {}) =>
	snapshotItem("B7", { state: "todo", goal: "Ship the fix", why: "Users cannot save", version: 3, ...overrides });
const domain: WorkspaceSnapshot = { sessionId: "s", agents: [], traffic: [], events: [], receipts: [] };
const fetchMock = vi.fn<typeof fetch>();
const commands = () => fetchMock.mock.calls.map(([, options]) => JSON.parse(String(options?.body)));
const accepted = () =>
	new Response(
		JSON.stringify({ receipt: { ...commands().at(-1), status: "accepted", message: "Implementation queued", at: 0 } }),
	);

beforeEach(() => {
	FakeSocket.instances = [];
	fetchMock.mockReset().mockImplementation(async () => accepted());
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function live(children: ReactNode) {
	const store = createBacklogStore(backlog);
	const wrap = (content: ReactNode) => (
		<LiveProvider access="token" backlog={store}>
			{content}
		</LiveProvider>
	);
	const view = render(wrap(children));
	return {
		show: (content: ReactNode) => view.rerender(wrap(content)),
		push: async (snapshot = domain) => {
			act(() => FakeSocket.instances[0].receive("workspace", snapshot));
			await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
		},
	};
}

describe("backlog implementation controls", () => {
	it("puts implementation first in the item actions and sends its ref/version to the host", async () => {
		const view = live(<ItemActions item={ready()} />);
		const implement = screen.getByRole("button", { name: "Implement B7" });
		expect(implement).toBeDisabled();
		expect(screen.getByText("Implement backlog item B7")).toBeInTheDocument();
		expect(screen.getAllByRole("button")[0]).toBe(implement);
		await view.push();
		await userEvent.click(implement);
		expect(await screen.findByText("Implementation queued")).toBeInTheDocument();
		expect(implement).toBeDisabled();
		expect(commands()).toEqual([expect.objectContaining({ action: "work", backlogId: "B7", version: 3 })]);
		expect(screen.getByRole("link", { name: "View activity" })).toHaveAttribute("href", "#activity");
	});

	it("explains missing goals, unresolved dependencies and finished work before sending anything", async () => {
		const view = live(<ItemImplementation item={ready({ goal: "" })} />);
		await view.push();
		expect(screen.getByRole("button", { name: "Implement B7" })).toBeDisabled();
		expect(screen.getByText(/Add a goal and reason/)).toBeInTheDocument();
		view.show(<ItemImplementation item={ready({ blockedBy: ["B2"] })} />);
		expect(screen.getByText("Blocked by B2. Complete the dependencies first.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Implement B7" })).toBeDisabled();
		view.show(<ItemImplementation item={ready({ state: "done" })} />);
		expect(screen.getByText("Reopen the item to start more work.")).toBeInTheDocument();
		expect(commands()).toEqual([]);
	});

	it("shares pending work between card and detail controls and permits a newly reopened version", async () => {
		let finish: (response: Response) => void = () => {};
		fetchMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const view = live(
			<>
				<ItemQuickAction item={ready()} />
				<ItemImplementation item={ready()} />
			</>,
		);
		await view.push();
		const buttons = screen.getAllByRole("button", { name: "Implement B7" });
		await userEvent.click(buttons[0]);
		for (const button of buttons) {
			expect(button).toBeDisabled();
			expect(button).toHaveAttribute("aria-busy", "true");
		}
		await userEvent.click(buttons[1]);
		expect(commands()).toHaveLength(1);
		await act(async () => finish(accepted()));
		view.show(<ItemQuickAction item={ready()} />);
		expect(screen.getByRole("button", { name: "Implement B7" })).toBeDisabled();
		view.show(<ItemQuickAction item={ready({ version: 6 })} />);
		await userEvent.click(screen.getByRole("button", { name: "Implement B7" }));
		expect(commands()).toHaveLength(2);
		expect(commands()[1]).toMatchObject({ version: 6 });
		expect(commands()[1].id).not.toBe(commands()[0].id);
	});

	it("keeps the same request id when navigation follows an uncertain network result", async () => {
		fetchMock.mockRejectedValueOnce(new Error("Disconnected"));
		const view = live(<ItemQuickAction item={ready()} />);
		await view.push();
		await userEvent.click(screen.getByRole("button", { name: "Implement B7" }));
		expect(await screen.findByText(/Disconnected Retry checks the same request/)).toBeInTheDocument();
		view.show(<ItemActions item={ready()} />);
		await userEvent.click(screen.getByRole("button", { name: "Implement B7" }));
		await screen.findByText("Implementation queued");
		expect(commands()[1].id).toBe(commands()[0].id);
	});

	it("settles pending requests from pushed receipts and permits a failed request to be retried", async () => {
		fetchMock.mockImplementationOnce(
			async () =>
				new Response(
					JSON.stringify({ receipt: { ...commands().at(-1), status: "pending", message: "Queued", at: 0 } }),
				),
		);
		const view = live(<ItemQuickAction item={ready()} />);
		await view.push();
		await userEvent.click(screen.getByRole("button", { name: "Implement B7" }));
		await screen.findByText("Queued");
		const id = commands()[0].id;
		await view.push({
			...domain,
			receipts: [{ id, action: "work", backlogId: "B7", status: "failed", message: "Session changed", at: 0 }],
		});
		expect(screen.getByText("Session changed")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Implement B7" }));
		await screen.findByText("Implementation queued");
		expect(commands()[1].id).not.toBe(id);
	});

	it("requires posting or clearing a comment draft before starting the item", async () => {
		const view = live(
			<>
				<ItemActions item={ready()} />
				<ItemActivity item={ready()} />
			</>,
		);
		await view.push();
		const comment = screen.getByRole("textbox", { name: "Comment" });
		await userEvent.type(comment, "Include this requirement");
		expect(screen.getByRole("button", { name: "Implement B7" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Request new agent" })).toBeDisabled();
		expect(screen.getAllByText(/Post or clear your comment draft/)).toHaveLength(2);
		await userEvent.clear(comment);
		await waitFor(() => expect(screen.getByRole("button", { name: "Implement B7" })).toBeEnabled());
		expect(commands()).toEqual([]);
	});
});
