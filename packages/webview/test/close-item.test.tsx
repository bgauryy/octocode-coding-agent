/** @vitest-environment jsdom */
import type { Snapshot } from "@octocodeai/octocode-contracts/snapshot";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { CloseItem } from "../src/app/live/CloseItem.tsx";
import { LiveProvider } from "../src/app/live/session.tsx";
import { FakeSocket, snapshotItem } from "./helpers.ts";

const backlog: Snapshot = {
	repo: "repo",
	generatedAt: 0,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 1,
	items: [],
};
const fetchMock = vi.fn<typeof fetch>();
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

beforeEach(() => {
	FakeSocket.instances = [];
	fetchMock
		.mockReset()
		.mockImplementation(async () => new Response(JSON.stringify({ item: { ref: "B7", version: 5 } })));
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function open() {
	const user = userEvent.setup();
	render(
		<LiveProvider access="token" backlog={createBacklogStore(backlog)}>
			<CloseItem item={snapshotItem("B7", { state: "todo", version: 4 })} />
		</LiveProvider>,
	);
	return user;
}
const form = () => screen.getByRole("form", { name: "Close B7" });

describe("CloseItem", () => {
	it("is not offered for a done or closed item", () => {
		render(
			<LiveProvider access="token" backlog={createBacklogStore(backlog)}>
				<CloseItem item={snapshotItem("B8", { state: "done" })} />
			</LiveProvider>,
		);
		expect(screen.queryByRole("button", { name: "Close…" })).toBeNull();
	});

	it("requires a reason and sends nothing without one", async () => {
		const user = open();
		await user.click(screen.getByRole("button", { name: "Close…" }));
		expect(screen.getByLabelText("Reason")).toBeRequired();
		await user.click(screen.getByRole("button", { name: "Close B7" }));
		expect(fetchMock).not.toHaveBeenCalled();
		expect(form()).toBeInTheDocument();
	});

	it("asks for the original item only for a duplicate", async () => {
		const user = open();
		await user.click(screen.getByRole("button", { name: "Close…" }));
		expect(screen.queryByLabelText("Duplicate of")).toBeNull();
		await user.selectOptions(screen.getByLabelText("Why is it closed?"), "duplicate");
		expect(screen.getByLabelText("Duplicate of")).toBeRequired();
		await user.type(screen.getByLabelText("Reason"), "Same thing");
		await user.click(screen.getByRole("button", { name: "Close B7" }));
		expect(fetchMock).not.toHaveBeenCalled();
		await user.type(screen.getByLabelText("Duplicate of"), "b3");
		await user.click(screen.getByRole("button", { name: "Close B7" }));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(bodies()[0]).toEqual({
			command: "item.close",
			id: "B7",
			version: 4,
			kind: "duplicate",
			text: "Same thing",
			of: "B3",
		});
	});

	it("shows a server error in an alert and keeps the form open", async () => {
		fetchMock.mockImplementation(
			async () => new Response(JSON.stringify({ error: "B7 changed elsewhere" }), { status: 409 }),
		);
		const user = open();
		await user.click(screen.getByRole("button", { name: "Close…" }));
		await user.type(screen.getByLabelText("Reason"), "No longer needed");
		await user.click(screen.getByRole("button", { name: "Close B7" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/changed elsewhere/);
		expect(form()).toBeInTheDocument();
	});

	it("sends item.close with the version and closes the form on success", async () => {
		const user = open();
		await user.click(screen.getByRole("button", { name: "Close…" }));
		await user.selectOptions(screen.getByLabelText("Why is it closed?"), "wont_do");
		await user.type(screen.getByLabelText("Reason"), "  Out of scope  ");
		await user.click(screen.getByRole("button", { name: "Close B7" }));
		await waitFor(() => expect(screen.queryByRole("form", { name: "Close B7" })).toBeNull());
		expect(bodies()).toEqual([{ command: "item.close", id: "B7", version: 4, kind: "wont_do", text: "Out of scope" }]);
	});
});
