/** @vitest-environment jsdom */
import type { Snapshot } from "@octocodeai/octocode-contracts/snapshot";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { daemonLive } from "../src/app/daemon/live.ts";
import { createBacklogStore } from "../src/app/extension.ts";
import { live } from "../src/app/live/index.ts";
import { FakeSocket, snapshotItem } from "./helpers.ts";

const snapshot: Snapshot = {
	repo: "repo",
	generatedAt: 1000,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 100_000,
	items: [snapshotItem("B1", { title: "Fix the save bug", state: "todo", goal: "Saving works" })],
};
const fetchMock = vi.fn<typeof fetch>();
const page = (scope: "repo" | "session") => {
	if (!live) throw new Error("live extension");
	return <App backlog={createBacklogStore(snapshot)} live={daemonLive(live, { kind: scope, id: "x" })} access="tok" />;
};

beforeEach(() => {
	FakeSocket.instances = [];
	fetchMock.mockReset().mockImplementation(async () => new Response("{}", { status: 200 }));
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", fetchMock);
	history.replaceState(null, "", "#board");
});
afterEach(() => vi.unstubAllGlobals());

describe("daemon repository scope (read-only board)", () => {
	it("marks only the repository scope read-only", () => {
		if (!live) throw new Error("live extension");
		expect(daemonLive(live, { kind: "repo", id: "r" }).readOnly).toBe(true);
		expect(daemonLive(live, { kind: "session", id: "s" }).readOnly).toBeUndefined();
	});

	it("hides New item and the card Implement button", () => {
		render(page("repo"));
		expect(screen.getByRole("link", { name: "Fix the save bug" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /New item/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /Implement/ })).toBeNull();
	});

	it("draws no drag, inline add, or write entry on a card", async () => {
		const user = userEvent.setup();
		const { container } = render(page("repo"));
		expect(container.querySelector("[draggable=true]")).toBeNull();
		expect(screen.queryByRole("button", { name: /Add a card/ })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Actions for B1" }));
		expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open", "Copy ref"]);
	});

	it("leaves out Create new item from the palette and ignores the C shortcut", async () => {
		const user = userEvent.setup();
		render(page("repo"));
		await user.keyboard("{Control>}k{/Control}");
		const palette = await screen.findByRole("dialog");
		expect(within(palette).queryByText("Create new item")).toBeNull();
		await user.keyboard("{Escape}");
		await user.keyboard("c");
		expect(location.hash).toBe("#board");
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("shows the item without edit, Implement or comment controls, and explains why", async () => {
		history.replaceState(null, "", "#B1");
		render(page("repo"));
		const sheet = await screen.findByRole("dialog", { name: "Fix the save bug" });
		expect(within(sheet).getByText(/read-only here/)).toBeInTheDocument();
		expect(within(sheet).queryByRole("button", { name: /Implement/ })).toBeNull();
		expect(within(sheet).queryByRole("button", { name: /Edit/ })).toBeNull();
		expect(within(sheet).queryByRole("textbox")).toBeNull();
	});

	it("does not open the editor from an edit or new link", async () => {
		history.replaceState(null, "", "#B1/edit");
		const { unmount } = render(page("repo"));
		expect(await screen.findByRole("dialog", { name: "Fix the save bug" })).toBeInTheDocument();
		expect(screen.queryByRole("textbox")).toBeNull();
		unmount();
		history.replaceState(null, "", "#new");
		render(page("repo"));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps every control in a session scope", async () => {
		history.replaceState(null, "", "#B1");
		render(page("session"));
		const sheet = await screen.findByRole("dialog", { name: "Fix the save bug" });
		expect(within(sheet).getByRole("button", { name: /Implement B1/ })).toBeInTheDocument();
		expect(within(sheet).getByRole("button", { name: /Edit/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /New item/ })).toBeInTheDocument();
	});
});
