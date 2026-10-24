/** @vitest-environment jsdom */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsView } from "../src/app/live/AgentsView.tsx";
import { MessageForm } from "../src/app/live/controls.tsx";
import { ItemActivity } from "../src/app/live/ItemPanels.tsx";
import { controlView, deferredControl, fetchControl, member, posted, setupControls } from "./control-fixtures.tsx";
import { snapshotItem } from "./helpers.ts";

beforeEach(setupControls);
afterEach(() => vi.unstubAllGlobals());

it("retains a recipient that disappears as unavailable and requires a new selection", async () => {
	const view = controlView(<MessageForm agentId="worker" />);
	await view.workspace();
	await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Review this");
	await view.workspace({ agents: [member({ id: "main", role: "main" })] });
	expect(screen.getByRole("option", { name: "worker · unavailable" })).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Send to agent" })).toBeDisabled();
	expect(screen.getByText(/This agent is no longer available/)).toBeInTheDocument();
	await userEvent.selectOptions(screen.getByRole("combobox", { name: "Recipient" }), "main");
	await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
	expect(posted()[0]).toMatchObject({ action: "message", to: "main", text: "Review this" });
});

it("does not erase a newer agent draft when a previous view's send finishes", async () => {
	const finish = deferredControl();
	const view = controlView(<MessageForm agentId="worker" />);
	await view.workspace();
	await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Old message");
	await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
	view.show(null);
	view.show(<MessageForm agentId="worker" />);
	const box = screen.getByRole("textbox", { name: "Message" });
	await userEvent.clear(box);
	await userEvent.type(box, "New draft");
	await act(async () => finish());
	expect(box).toHaveValue("New draft");
});

it("does not restore a failed old-session message into the new session", async () => {
	const finish = deferredControl();
	const view = controlView(<MessageForm agentId="worker" />);
	await view.workspace();
	await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Old draft");
	await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
	await view.workspace({ sessionId: "new" });
	const box = screen.getByRole("textbox", { name: "Message" });
	await userEvent.type(box, "New session draft");
	await act(async () => finish("failed", "Old failure"));
	expect(box).toHaveValue("New session draft");
	expect(screen.queryByText("Old failure")).toBeNull();
});

it("freezes item version across uncertain message retries", async () => {
	fetchControl.mockRejectedValueOnce(new Error("Lost response"));
	const item = snapshotItem("B7", { version: 2 });
	const view = controlView(<MessageForm item={item} agentId="worker" />);
	await view.workspace();
	await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Follow up");
	await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
	await screen.findByText(/Lost response/);
	view.show(<MessageForm item={{ ...item, version: 3 }} agentId="worker" />);
	await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
	expect(posted()[1]).toMatchObject({ id: posted()[0].id, version: 2 });
});

it("does not clear a newly edited comment when the previous view finishes saving", async () => {
	let finish: (response: Response) => void = () => {};
	fetchControl.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	fetchControl.mockResolvedValueOnce(
		new Response(
			JSON.stringify({
				repo: "test",
				generatedAt: 1,
				states: ["backlog", "todo", "ongoing", "done"],
				idleMs: 1,
				items: [],
			}),
		),
	);
	const item = snapshotItem("B7");
	const view = controlView(<ItemActivity item={item} />);
	await view.workspace();
	await userEvent.type(screen.getByRole("textbox", { name: "Comment" }), "First comment");
	const form = screen.getByRole("textbox", { name: "Comment" }).closest("form")!;
	fireEvent.submit(form);
	fireEvent.submit(form);
	expect(fetchControl).toHaveBeenCalledTimes(1);
	view.show(null);
	view.show(<ItemActivity item={item} />);
	const box = screen.getByRole("textbox", { name: "Comment" });
	await userEvent.clear(box);
	await userEvent.type(box, "Next comment");
	await act(async () => finish(new Response(JSON.stringify({ item: { ref: "B7", version: 2 } }))));
	expect(box).toHaveValue("Next comment");
});

it("reenables stop when a lingering agent starts another run and points main control to Activity", async () => {
	const view = controlView(<AgentsView />);
	await view.workspace({ agents: [member(), member({ id: "main", role: "main" })] });
	await userEvent.click(screen.getByRole("button", { name: "Request stop" }));
	await waitFor(() => expect(screen.getByRole("button", { name: "Request stop" })).toBeDisabled());
	expect(screen.getByRole("link", { name: "Open session controls" })).toHaveAttribute("href", "#activity");
	await view.workspace({ agents: [member({ status: "idle" })] });
	await view.workspace({ agents: [member({ status: "working" })] });
	await userEvent.click(screen.getByRole("button", { name: "Request stop" }));
	expect(posted()).toHaveLength(2);
	expect(posted()[1].id).not.toBe(posted()[0].id);
});

it("warns about cached agent data during a disconnect while preserving the HTTP send path", async () => {
	const view = controlView(<MessageForm agentId="worker" />);
	await view.workspace();
	view.disconnect();
	expect(screen.getByRole("note")).toHaveTextContent("agent availability and progress may be out of date");
	await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Send through HTTP");
	await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
	expect(posted()).toHaveLength(1);
});
