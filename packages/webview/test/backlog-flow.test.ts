import { within } from "@testing-library/dom";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import { renderBacklogHtml } from "../src/index.ts";
import { FakeSocket, snapshotItem } from "./helpers.ts";

const pages: JSDOM[] = [];
afterEach(() => {
	for (const page of pages.splice(0)) page.window.close();
	FakeSocket.instances.length = 0;
});

it("implements a task from the generated Backlog page and preserves the receipt in its details", async () => {
	const item = snapshotItem("B12", {
		title: "Make backlog work visible",
		state: "todo",
		goal: "Start work directly from the backlog",
		why: "Users need a visible implementation action",
		version: 7,
		comments: [
			{ id: 1, backlogId: "B12", author: "Reviewer", at: 1, text: "Keep the keyboard workflow accessible." },
			{ id: 2, backlogId: "B12", author: "Owner", at: 2, text: "Include every comment in the agent handoff." },
		],
	});
	const snapshot = {
		repo: "workspace",
		generatedAt: 10,
		states: ["backlog", "todo", "ongoing", "done"] as const,
		idleMs: 1000,
		items: [item],
	};
	const fetch = vi.fn(async (_url: string, init: RequestInit) => {
		const command = JSON.parse(String(init.body));
		return {
			ok: true,
			json: async () => ({
				receipt: {
					id: command.id,
					action: command.action,
					backlogId: command.backlogId,
					at: 1,
					status: "accepted",
					message: "Implementation requested for B12.",
				},
			}),
		};
	});
	const dom = new JSDOM(renderBacklogHtml({ ...snapshot, items: [] }, true), {
		url: "http://localhost/#access=test&view=backlog",
		runScripts: "dangerously",
		pretendToBeVisual: true,
		beforeParse(window) {
			Object.defineProperty(window, "WebSocket", { value: FakeSocket });
			Object.defineProperty(window, "fetch", { value: fetch });
			window.scrollTo = () => {};
		},
	});
	pages.push(dom);
	const screen = within(dom.window.document.body);
	await vi.waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
	const socket = FakeSocket.instances.at(-1)!;
	socket.receive("workspace", { sessionId: "main", agents: [], traffic: [], events: [], receipts: [] });
	socket.receive("snapshot", snapshot);
	const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Implement B12" });
	expect(dom.window.location.hash).toBe("#backlog");
	expect(dom.window.sessionStorage.getItem("backlog-access")).toBe("test");
	await vi.waitFor(() => expect(button.disabled).toBe(false));
	button.click();
	button.click();
	await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
	const [url, request] = fetch.mock.calls[0];
	expect(url).toBe("/api/workspace");
	expect(request.headers).toMatchObject({ Authorization: "Bearer test" });
	expect(JSON.parse(String(request.body))).toEqual({
		id: expect.any(String),
		action: "work",
		backlogId: "B12",
		version: 7,
	});
	await vi.waitFor(() => expect(button.disabled).toBe(true));
	expect(await screen.findByRole("link", { name: "View activity" })).toBeTruthy();

	dom.window.location.hash = "#B12";
	dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
	const detail = within(await screen.findByRole("dialog"));
	expect(await detail.findByText("Keep the keyboard workflow accessible.")).toBeTruthy();
	expect(detail.getByText("Include every comment in the agent handoff.")).toBeTruthy();
	expect(detail.getByText("Implement backlog item B12")).toBeTruthy();
	const detailButton = detail.getByRole<HTMLButtonElement>("button", { name: "Implement B12" });
	expect(detailButton.disabled).toBe(true);
	detailButton.click();
	expect(fetch).toHaveBeenCalledOnce();

	socket.receive("snapshot", {
		...snapshot,
		items: [{ ...item, state: "ongoing", version: 8, assignee: "main" }],
	});
	await vi.waitFor(() =>
		expect(detail.getByRole("button", { name: "Implement B12" }).getAttribute("title")).toBe(
			"Already claimed. Message the agent to follow up.",
		),
	);
	expect(detail.getByRole("link", { name: "View activity" }).getAttribute("href")).toBe("#activity");
});
