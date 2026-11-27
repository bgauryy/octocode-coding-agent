/** @vitest-environment jsdom */
import type { Snapshot } from "@octocodeai/octocode-contracts/snapshot";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { daemonLive } from "../src/app/daemon/live.ts";
import { createBacklogStore } from "../src/app/extension.ts";
import { live } from "../src/app/live/index.ts";
import { FakeSocket, snapshotItem } from "./helpers.ts";

const snapshot: Snapshot = {
	repo: "octo-repo",
	generatedAt: 1000,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 100_000,
	items: [snapshotItem("B1", { title: "Fix the save bug", state: "todo", goal: "Saving works" })],
};
const fetchMock = vi.fn<typeof fetch>();
let stored = { sound: false, theme: "system" };

/** A host that keeps the preferences, as the real one does. */
async function host(_url: unknown, init?: RequestInit) {
	if (init?.method === "POST") stored = { ...stored, ...JSON.parse(String(init.body)) };
	return new Response(JSON.stringify(stored), { status: 200 });
}
const page = (scope: "repo" | "session") => {
	if (!live) throw new Error("live extension");
	return <App backlog={createBacklogStore(snapshot)} live={daemonLive(live, { kind: scope, id: "x" })} access="tok" />;
};
async function go(hash: string) {
	await act(async () => {
		location.hash = hash;
		window.dispatchEvent(new HashChangeEvent("hashchange"));
	});
}
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

beforeEach(() => {
	FakeSocket.instances = [];
	stored = { sound: false, theme: "system" };
	fetchMock.mockReset().mockImplementation(host);
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", fetchMock);
	history.replaceState(null, "", "#board");
});
afterEach(() => {
	vi.unstubAllGlobals();
	delete document.documentElement.dataset.theme;
});

describe("page title", () => {
	it("names the current view", async () => {
		render(<App backlog={createBacklogStore(snapshot)} live={null} />);
		expect(document.title).toBe("Board · Octocode");
		await go("#table");
		expect(document.title).toBe("Table · Octocode");
		await go("#tree");
		expect(document.title).toBe("Tree · Octocode");
	});
});

describe("landmarks", () => {
	it("has a main landmark and a skip link that moves focus there without leaving the view", async () => {
		const user = userEvent.setup();
		render(<App backlog={createBacklogStore(snapshot)} live={null} />);
		const main = screen.getByRole("main");
		const skip = screen.getByRole("link", { name: "Skip to content" });
		await user.tab();
		expect(skip).toHaveFocus();
		await user.keyboard("{Enter}");
		expect(main).toHaveFocus();
		expect(location.hash).toBe("#board");
	});
});

describe("theme", () => {
	it("applies Light, Dark and System to the document on an offline page", async () => {
		const user = userEvent.setup();
		render(<App backlog={createBacklogStore(snapshot)} live={null} />);
		const group = screen.getByRole("group", { name: "Theme" });
		await user.click(within(group).getByRole("button", { name: "Dark" }));
		expect(document.documentElement.dataset.theme).toBe("dark");
		await user.click(within(group).getByRole("button", { name: "Light" }));
		expect(document.documentElement.dataset.theme).toBe("light");
		await user.click(within(group).getByRole("button", { name: "System" }));
		expect(document.documentElement.dataset.theme).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reads the host-stored theme and saves a change on an editable live page", async () => {
		stored = { sound: false, theme: "dark" };
		const user = userEvent.setup();
		render(page("session"));
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
		const group = screen.getByRole("group", { name: "Theme" });
		expect(within(group).getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
		await user.click(within(group).getByRole("button", { name: "Light" }));
		await waitFor(() => expect(stored.theme).toBe("light"));
		expect(posts()).toHaveLength(1);
		expect(JSON.parse(String(posts()[0][1]?.body))).toEqual({ theme: "light" });
		expect(document.documentElement.dataset.theme).toBe("light");
	});

	it("reads the stored theme once, and ignores a read that arrives after the user chose", async () => {
		stored = { sound: false, theme: "dark" };
		let release!: () => void;
		fetchMock.mockImplementationOnce(
			(_url, init) =>
				new Promise<Response>((resolve) => {
					release = () => void host(_url, init).then(resolve);
				}),
		);
		const user = userEvent.setup();
		render(page("session"));
		const group = screen.getByRole("group", { name: "Theme" });
		await user.click(within(group).getByRole("button", { name: "Light" }));
		await act(async () => release());
		expect(document.documentElement.dataset.theme).toBe("light");
		expect(within(group).getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
		const reads = fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST");
		expect(reads).toHaveLength(1);
	});

	it("applies the choice for the visit on a read-only page but sends nothing", async () => {
		const user = userEvent.setup();
		render(page("repo"));
		await user.click(within(screen.getByRole("group", { name: "Theme" })).getByRole("button", { name: "Dark" }));
		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(posts()).toHaveLength(0);
		expect(stored.theme).toBe("system");
	});
});

describe("popover", () => {
	it("closes on Escape with focus back on its button, and on a click outside", async () => {
		const user = userEvent.setup();
		render(<App backlog={createBacklogStore(snapshot)} live={null} />);
		const button = screen.getByLabelText("Workspace menu");
		const menu = button.closest("details") as HTMLDetailsElement;
		await user.click(button);
		expect(menu.open).toBe(true);
		await user.click(within(menu).getByRole("button", { name: "Dark" }));
		expect(menu.open).toBe(true);
		await user.keyboard("{Escape}");
		expect(menu.open).toBe(false);
		expect(button).toHaveFocus();
		await user.click(button);
		expect(menu.open).toBe(true);
		await user.click(document.body);
		expect(menu.open).toBe(false);
	});
});

describe("item actions menu", () => {
	it("groups Edit, Close, Add task and Add comment under one Actions menu beside Implement", async () => {
		const user = userEvent.setup();
		render(page("session"));
		await go("#B1");
		const sheet = await screen.findByRole("dialog");
		expect(within(sheet).getByRole("button", { name: /Implement/ })).toBeInTheDocument();
		const trigger = within(sheet).getByText("Actions ▾");
		const panel = trigger.closest("details")?.querySelector<HTMLElement>(".menu-panel");
		expect(panel).not.toBeNull();
		const menu = within(panel as HTMLElement);
		for (const name of ["Edit", "Close…", "Add task", "Add comment"])
			expect(menu.getByRole("button", { name })).toBeInTheDocument();
		// The old flat button is gone.
		expect(within(sheet).queryByRole("button", { name: "Edit / change status" })).toBeNull();

		await user.click(trigger);
		await user.click(menu.getByRole("button", { name: "Add comment" }));
		expect(sheet.querySelector("[data-add-comment] textarea")).toHaveFocus();
		expect((trigger.closest("details") as HTMLDetailsElement).open).toBe(false);

		await user.click(trigger);
		await user.click(menu.getByRole("button", { name: "Edit" }));
		expect(location.hash).toBe("#B1/edit");
	});

	it("shows no Actions menu on a read-only page", async () => {
		render(page("repo"));
		await go("#B1");
		const sheet = await screen.findByRole("dialog");
		expect(within(sheet).queryByText("Actions ▾")).toBeNull();
	});
});
