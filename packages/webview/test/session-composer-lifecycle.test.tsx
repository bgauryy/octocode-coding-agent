/** @vitest-environment jsdom */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionComposer } from "../src/app/live/SessionComposer.tsx";
import { controlView, deferredControl, fetchControl, posted, receipt, setupControls } from "./control-fixtures.tsx";

beforeEach(setupControls);
afterEach(() => vi.unstubAllGlobals());

async function composer(streaming = false) {
	const view = controlView(<SessionComposer />);
	await view.workspace();
	await view.session({ streaming, ...(streaming ? { runId: "run-1" } : {}) });
	return view;
}

it("retains a failed session message and retries under a fresh request id", async () => {
	fetchControl.mockImplementationOnce(async (_url, init) => receipt(init, "failed", "Model unavailable"));
	await composer();
	const box = screen.getByRole("textbox", { name: "Message" });
	await userEvent.type(box, "Implement the issue");
	await userEvent.click(screen.getByRole("button", { name: "Send" }));
	await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
	expect(box).toHaveValue("Implement the issue");
	await userEvent.click(screen.getByRole("button", { name: "Send" }));
	await waitFor(() => expect(box).toHaveValue(""));
	expect(posted()[1]).toMatchObject({ action: "prompt", text: "Implement the issue" });
	expect(posted()[1].id).not.toBe(posted()[0].id);
});

it("keeps the request id across navigation after a lost session-message response", async () => {
	fetchControl.mockRejectedValueOnce(new Error("Disconnected"));
	const view = await composer();
	await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Retry safely");
	await userEvent.click(screen.getByRole("button", { name: "Send" }));
	await screen.findByText(/Disconnected Retry checks the same request/);
	view.show(null);
	view.show(<SessionComposer />);
	await userEvent.click(screen.getByRole("button", { name: "Send" }));
	expect(posted()[1].id).toBe(posted()[0].id);
});

it("preserves a newer session draft when an older view's response arrives", async () => {
	const finish = deferredControl();
	const view = await composer();
	await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "First task");
	const form = screen.getByRole("textbox", { name: "Message" }).closest("form")!;
	fireEvent.submit(form);
	fireEvent.submit(form);
	expect(posted()).toHaveLength(1);
	view.show(null);
	view.show(<SessionComposer />);
	const box = screen.getByRole("textbox", { name: "Message" });
	await userEvent.clear(box);
	await userEvent.type(box, "Second draft");
	await act(async () => finish());
	expect(box).toHaveValue("Second draft");
});

it("ignores a late response after switching sessions", async () => {
	const finish = deferredControl();
	const view = await composer();
	await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Old session task");
	await userEvent.click(screen.getByRole("button", { name: "Send" }));
	await view.session({ sessionId: "new" });
	const box = screen.getByRole("textbox", { name: "Message" });
	await userEvent.type(box, "New session task");
	await act(async () => finish("failed", "Old rejection"));
	expect(box).toHaveValue("New session task");
	expect(screen.queryByText("Old rejection")).toBeNull();
});

it("reenables abort after rejection and uses a new id while retaining accepted stops across navigation", async () => {
	fetchControl.mockImplementationOnce(async (_url, init) => receipt(init, "failed", "Try again"));
	const view = await composer(true);
	await userEvent.click(screen.getByRole("button", { name: "Stop current run" }));
	await waitFor(() => expect(screen.getByRole("button", { name: "Stop current run" })).toBeEnabled());
	await userEvent.click(screen.getByRole("button", { name: "Stop current run" }));
	await waitFor(() => expect(screen.getByRole("button", { name: "Stop current run" })).toBeDisabled());
	expect(posted()[1].id).not.toBe(posted()[0].id);
	view.show(null);
	view.show(<SessionComposer />);
	expect(screen.getByRole("button", { name: "Stop current run" })).toBeDisabled();
	await view.session({ streaming: true, runId: "run-2" });
	await userEvent.click(screen.getByRole("button", { name: "Stop current run" }));
	expect(posted()[2]).toMatchObject({ action: "abort", runId: "run-2" });
	expect(posted()[2].id).not.toBe(posted()[1].id);
});

it("allows abort retry after an accepted request later fails in the application stream", async () => {
	const view = await composer(true);
	await userEvent.click(screen.getByRole("button", { name: "Stop current run" }));
	await waitFor(() => expect(screen.getByRole("button", { name: "Stop current run" })).toBeDisabled());
	const id = posted()[0].id;
	await view.session({
		streaming: true,
		runId: "run-1",
		receipts: [{ id, status: "failed", message: "Stop rejected" }],
	});
	await userEvent.click(screen.getByRole("button", { name: "Stop current run" }));
	expect(posted()[1].id).not.toBe(id);
});

it("does not apply an old abort response to a later run", async () => {
	const finish = deferredControl();
	const view = await composer(true);
	await userEvent.click(screen.getByRole("button", { name: "Stop current run" }));
	await view.session({ streaming: true, runId: "run-2" });
	await act(async () => finish("failed", "Previous run failed to stop"));
	expect(screen.getByRole("button", { name: "Stop current run" })).toBeEnabled();
	await userEvent.click(screen.getByRole("button", { name: "Stop current run" }));
	expect(posted()[1]).toMatchObject({ action: "abort", runId: "run-2" });
});

it("keeps image drafts when switching to a text-only model and allows removing the attachment", async () => {
	const view = await composer();
	const asset = { id: "image-1", mimeType: "image/png", size: 3, name: "screen.png" };
	fetchControl.mockImplementationOnce(async () => new Response(JSON.stringify({ asset })));
	fireEvent.change(screen.getByLabelText("Attach images"), {
		target: { files: [new File(["png"], "screen.png", { type: "image/png" })] },
	});
	await screen.findByText("screen.png");
	await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Inspect this");
	await view.session({ model: { provider: "custom", id: "text", name: "Text model", input: ["text"] } });
	expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
	expect(screen.getByLabelText("Attach images")).toBeDisabled();
	expect(screen.getByRole("alert")).toHaveTextContent("Select an image-capable model");
	expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Inspect this");
	await userEvent.click(screen.getByRole("button", { name: "Remove screen.png" }));
	expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
	expect(screen.queryByText("screen.png")).toBeNull();
});

it("reenables a retained image draft when selecting a model that accepts images", async () => {
	const view = await composer();
	const asset = { id: "image-1", mimeType: "image/png", size: 3, name: "screen.png" };
	fetchControl.mockImplementationOnce(async () => new Response(JSON.stringify({ asset })));
	fireEvent.change(screen.getByLabelText("Attach images"), {
		target: { files: [new File(["png"], "screen.png", { type: "image/png" })] },
	});
	await screen.findByText("screen.png");
	await view.session({ model: { provider: "custom", id: "text", name: "Text model", input: ["text"] } });
	expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
	await view.session({ model: { provider: "custom", id: "vision", name: "Vision model", input: ["text", "image"] } });
	expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
	expect(screen.getByLabelText("Attach images")).toBeEnabled();
	expect(screen.getByText("screen.png")).toBeVisible();
});

it("identifies the receiving session and keeps a draft editable while disconnected", async () => {
	const view = await composer();
	expect(screen.getByText(/Messages go to the terminal session that opened this page/)).toHaveTextContent("s");
	const box = screen.getByRole("textbox", { name: "Message" });
	await userEvent.type(box, "Keep my message");
	view.disconnect();
	expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
	await userEvent.type(box, " until reconnected");
	fireEvent.submit(box.closest("form")!);
	expect(posted()).toEqual([]);
	expect(box).toHaveValue("Keep my message until reconnected");
});

it("restores a message rejected after acceptance without overwriting a newer draft", async () => {
	const view = await composer();
	const box = screen.getByRole("textbox", { name: "Message" });
	await userEvent.type(box, "Please implement this");
	await userEvent.click(screen.getByRole("button", { name: "Send" }));
	await waitFor(() => expect(box).toHaveValue(""));
	const id = posted()[0].id;
	await userEvent.type(box, "New draft");
	await view.session({ receipts: [{ id, status: "failed", message: "Provider unavailable" }] });
	expect(screen.getByRole("button", { name: "Restore message" })).toBeDisabled();
	expect(box).toHaveValue("New draft");
	await userEvent.clear(box);
	view.show(null);
	view.show(<SessionComposer />);
	await userEvent.click(screen.getByRole("button", { name: "Restore message" }));
	expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Please implement this");
	await userEvent.click(screen.getByRole("button", { name: "Send" }));
	expect(posted()[1].id).not.toBe(id);
	expect(posted()[1].sessionId).toBe("s");
});

it("distinguishes a queued follow-up from a completed answer", async () => {
	await composer(true);
	await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Then review the result");
	await userEvent.selectOptions(screen.getByRole("combobox", { name: "When to send" }), "followUp");
	fetchControl.mockImplementationOnce(async (_url, init) => receipt(init, "completed", ""));
	await userEvent.click(screen.getByRole("button", { name: "Send" }));
	expect(await screen.findByText("Follow-up queued")).toBeVisible();
	expect(screen.queryByText("Completed")).toBeNull();
});

it("gives the messages a Stop withdrew from the queue back to the message box, once, before the draft", async () => {
	const view = await composer(true);
	const box = screen.getByRole("textbox", { name: "Message" });
	await userEvent.type(box, "my draft");
	await userEvent.click(screen.getByRole("button", { name: "Stop current run" }));
	const id = posted()[0].id;
	const stopped = { id, status: "completed" as const, withdrawn: ["queued guidance", "queued follow-up"] };
	await view.session({ streaming: false, receipts: [stopped] });
	await waitFor(() => expect(box).toHaveValue("queued guidance\n\nqueued follow-up\n\nmy draft"));
	await view.session({ streaming: false, receipts: [{ ...stopped }] });
	expect(box).toHaveValue("queued guidance\n\nqueued follow-up\n\nmy draft");
});
