/** @vitest-environment jsdom */
import type { Snapshot, SnapshotItem } from "@octocodeai/octocode-contacts/snapshot";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { Editor } from "../src/app/live/Editor.tsx";
import { LiveProvider, useLive } from "../src/app/live/session.tsx";
import { FakeSocket, snapshotItem } from "./helpers.ts";

const snapshot: Snapshot = {
	repo: "repo",
	generatedAt: 0,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 1000,
	items: [],
};
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
	FakeSocket.instances = [];
	fetchMock.mockReset();
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function renderEditor(item?: SnapshotItem) {
	const backlog = createBacklogStore({ ...snapshot, items: item ? [item] : [] });
	const onClose = vi.fn();
	let live!: ReturnType<typeof useLive>;
	function Capture() {
		const context = useLive();
		useEffect(() => {
			live = context;
		}, [context]);
		return null;
	}
	const tree = (entry?: SnapshotItem, shown = true) => (
		<LiveProvider access="token" backlog={backlog}>
			<Capture />
			{shown && <Editor item={entry} correction={false} onClose={onClose} />}
		</LiveProvider>
	);
	const view = render(tree(item));
	return {
		onClose,
		live: () => live,
		rerender: (entry?: SnapshotItem, shown = true) => view.rerender(tree(entry, shown)),
	};
}

describe("editor save lifecycle", () => {
	it("treats a successful save followed by refresh failure as saved and retries only the refresh", async () => {
		const user = userEvent.setup();
		fetchMock
			.mockResolvedValueOnce(ok({ item: { ref: "B9", version: 1 } }))
			.mockRejectedValueOnce(new Error("Offline"));
		const editor = renderEditor();
		await user.type(screen.getByRole("textbox", { name: "Title" }), "New work");
		await user.click(screen.getByRole("button", { name: "Save item" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Item saved. Offline");
		expect(screen.queryByRole("button", { name: "Save item" })).not.toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Title" })).toBeDisabled();
		expect(editor.live().workspace.getState().drafts["editor:new"]).toBeUndefined();
		expect(editor.onClose).not.toHaveBeenCalled();
		fetchMock.mockResolvedValueOnce(ok({ ...snapshot, items: [snapshotItem("B9")] }));
		await user.click(screen.getByRole("button", { name: "Open saved item" }));
		expect(editor.onClose).toHaveBeenCalledWith("B9");
		expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["POST", "GET", "GET"]);
	});

	it("blocks duplicate submissions and edits while pending without stealing navigation or deleting a newer draft", async () => {
		const user = userEvent.setup();
		let resolveSave!: (reply: Response) => void;
		fetchMock
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveSave = resolve;
					}),
			)
			.mockResolvedValueOnce(ok(snapshot));
		const editor = renderEditor();
		await user.type(screen.getByRole("textbox", { name: "Title" }), "First draft");
		const form = screen.getByRole("button", { name: "Save item" }).closest("form")!;
		fireEvent.submit(form);
		fireEvent.submit(form);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("textbox", { name: "Title" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Discard draft" })).toBeDisabled();
		editor.rerender(undefined, false);
		const first = editor.live().workspace.getState().drafts["editor:new"];
		act(() =>
			editor
				.live()
				.workspace.getState()
				.setDraft("editor:new", { ...first, text: "newer draft" }),
		);
		await act(async () => {
			resolveSave(ok({ item: { ref: "B9", version: 1 } }));
		});
		expect(editor.onClose).not.toHaveBeenCalled();
		expect(editor.live().workspace.getState().drafts["editor:new"].text).toBe("newer draft");
	});

	it("blocks a stale draft and reloads before discarding it, preserving edits when reload fails", async () => {
		const user = userEvent.setup();
		const item = snapshotItem("B1", { version: 1 });
		const editor = renderEditor(item);
		await user.type(screen.getByRole("textbox", { name: "Title" }), " local edit");
		editor.rerender({ ...item, version: 2, title: "Remote edit" });
		expect(screen.getByRole("note")).toHaveTextContent("changed after your draft started");
		expect(screen.getByRole("button", { name: "Save item" })).toBeDisabled();
		fetchMock.mockRejectedValueOnce(new Error("Offline"));
		await user.click(screen.getByRole("button", { name: "Discard draft" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Your draft was not discarded.");
		expect(editor.live().workspace.getState().drafts["editor:B1"]).toBeDefined();
		expect(editor.onClose).not.toHaveBeenCalled();
		fetchMock.mockResolvedValueOnce(ok(snapshot));
		await user.click(screen.getByRole("button", { name: "Discard draft" }));
		await waitFor(() => expect(editor.onClose).toHaveBeenCalledOnce());
		expect(editor.live().workspace.getState().drafts["editor:B1"]).toBeUndefined();
	});

	it("keeps the draft after a mutation conflict and exposes completion fields only for finishing work", async () => {
		const user = userEvent.setup();
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Version conflict" }), { status: 409 }));
		const editor = renderEditor(snapshotItem("B1", { state: "todo" }));
		await user.selectOptions(screen.getByRole("combobox", { name: "State" }), "done");
		expect(screen.getByRole("group", { name: "Completion" })).toBeInTheDocument();
		await user.type(screen.getByRole("textbox", { name: "What changed?" }), "Finished");
		await user.click(screen.getByRole("button", { name: "Save item" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Version conflict");
		expect(screen.getByRole("textbox", { name: "What changed?" })).toHaveValue("Finished");
		expect(editor.live().workspace.getState().drafts["editor:B1"]).toBeDefined();
		expect(editor.onClose).not.toHaveBeenCalled();
	});
});
