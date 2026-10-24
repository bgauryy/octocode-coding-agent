/** @vitest-environment jsdom */
import type { Snapshot } from "@octocodeai/octocode-contacts/snapshot";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { LiveProvider, useLive } from "../src/app/live/session.tsx";
import { FakeSocket, snapshotItem } from "./helpers.ts";

const snapshot = (generatedAt: number, title = "Current"): Snapshot => ({
	repo: "test",
	generatedAt,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 1,
	items: [snapshotItem("B1", { title })],
});

beforeEach(() => {
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
	let live!: ReturnType<typeof useLive>;
	function Capture() {
		const source = useLive();
		useEffect(() => {
			live = source;
		}, [source]);
		return null;
	}
	const backlog = createBacklogStore(snapshot(0));
	const view = render(
		<LiveProvider access="old-token" backlog={backlog}>
			<Capture />
		</LiveProvider>,
	);
	return {
		backlog,
		current: () => live,
		unmount: view.unmount,
		replace: (access: string, store = backlog) =>
			view.rerender(
				<LiveProvider access={access} backlog={store}>
					<Capture />
				</LiveProvider>,
			),
	};
}

it("recreates authenticated APIs, stores and socket when the access token changes", async () => {
	const fetch = vi.fn(async (_url?: string, _init?: RequestInit) => ({ ok: true, json: async () => snapshot(1) }));
	vi.stubGlobal("fetch", fetch);
	const app = mount();
	const previous = app.current();
	previous.workspace.getState().setDraft("private", { id: "old-draft", text: "Old session draft" });
	app.replace("new-token");
	expect(FakeSocket.instances).toHaveLength(2);
	expect(FakeSocket.instances[0].readyState).toBe(3);
	expect(app.current()).not.toBe(previous);
	expect(app.current().workspace.getState().drafts).toEqual({});
	await app.current().api.backlogs();
	expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Bearer new-token" } });
});

it("routes incoming snapshots and refreshes to the replacement backlog store", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => snapshot(2, "Refreshed") })),
	);
	const app = mount();
	const replacement = createBacklogStore(snapshot(0, "Replacement"));
	app.replace("old-token", replacement);
	act(() => FakeSocket.instances[1].receive("snapshot", snapshot(1, "Pushed")));
	expect(replacement.getState().snapshot.items[0].title).toBe("Pushed");
	await app.current().refresh();
	expect(replacement.getState().snapshot.items[0].title).toBe("Refreshed");
	expect(app.backlog.getState().snapshot.items[0].title).toBe("Current");
});

it("does not overwrite a newer socket snapshot with a slower refresh response", async () => {
	const response = Promise.withResolvers<{ ok: boolean; json(): Promise<Snapshot> }>();
	vi.stubGlobal(
		"fetch",
		vi.fn(() => response.promise),
	);
	const app = mount();
	const pending = app.current().refresh();
	act(() => FakeSocket.instances[0].receive("snapshot", snapshot(3, "Newer push")));
	response.resolve({ ok: true, json: async () => snapshot(2, "Older response") });
	await pending;
	expect(app.backlog.getState().snapshot.items[0].title).toBe("Newer push");
});

it("keeps the newer result when concurrent refresh responses arrive in reverse order", async () => {
	const first = Promise.withResolvers<{ ok: boolean; json(): Promise<Snapshot> }>();
	const second = Promise.withResolvers<{ ok: boolean; json(): Promise<Snapshot> }>();
	vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
	const app = mount();
	const pendingFirst = app.current().refresh();
	const pendingSecond = app.current().refresh();
	second.resolve({ ok: true, json: async () => snapshot(3, "Second") });
	await pendingSecond;
	first.resolve({ ok: true, json: async () => snapshot(2, "First") });
	await pendingFirst;
	expect(app.backlog.getState().snapshot.items[0].title).toBe("Second");
});

it.each(["replace", "unmount"])("does not publish an old refresh after provider %s", async (action) => {
	const response = Promise.withResolvers<{ ok: boolean; json(): Promise<Snapshot> }>();
	vi.stubGlobal(
		"fetch",
		vi.fn(() => response.promise),
	);
	const app = mount();
	const pending = app.current().refresh();
	const rejection = expect(pending).rejects.toThrow("Workspace changed while refreshing");
	if (action === "replace") app.replace("new-token");
	else app.unmount();
	response.resolve({ ok: true, json: async () => snapshot(20, "Retired response") });
	await rejection;
	expect(app.backlog.getState().snapshot.items[0].title).toBe("Current");
});

it.each([
	{ id: "other-request" },
	{ action: "delegate" },
	{ backlogId: "B2" },
	{ status: "completed" },
	{ message: { text: "not a string" } },
	{ at: null },
])("rejects an unrelated or malformed workspace receipt %o", async (patch) => {
	const command = { id: "request", action: "work" as const, backlogId: "B1", version: 1 };
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			json: async () => ({ receipt: { ...command, status: "accepted", at: 1, message: "Queued", ...patch } }),
		})),
	);
	const app = mount();
	await expect(app.current().api.command(command)).rejects.toThrow("Invalid workspace command receipt");
});

it("accepts a matching workspace receipt without changing its delivery status", async () => {
	const command = { id: "request", action: "work" as const, backlogId: "B1", version: 1 };
	const receipt = {
		id: command.id,
		action: command.action,
		backlogId: command.backlogId,
		status: "pending",
		at: 1,
		message: "Delivery pending",
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => ({ receipt }) })),
	);
	await expect(mount().current().api.command(command)).resolves.toEqual(receipt);
});

it("resets old drafts before exposing a new session and preserves its first typed characters", () => {
	vi.useFakeTimers();
	try {
		const app = mount();
		const live = app.current();
		const frame = (sessionId: string) => ({
			protocolVersion: 1,
			cursor: { sessionId, epoch: sessionId, sequence: 0 },
			at: 1,
			type: "snapshot",
			snapshot: {
				sessionId,
				messages: [],
				streaming: false,
				steering: [],
				followUp: [],
				receipts: [],
				capabilities: [],
			},
		});
		act(() => {
			FakeSocket.instances[0].receive("application", frame("old"));
			vi.advanceTimersByTime(101);
		});
		live.workspace.getState().setDraft("session-command:old", { id: "old", text: "Old draft" });
		let visibleWorkspace: string | undefined;
		const unsubscribe = live.session.subscribe((state) => {
			if (state.application?.sessionId !== "new") return;
			visibleWorkspace = live.workspace.getState().snapshot?.sessionId;
			live.workspace.getState().setDraft("session-command:new", { id: "new", text: "New session draft" });
		});
		act(() => FakeSocket.instances[0].receive("application", frame("new")));
		expect(visibleWorkspace).toBe("new");
		act(() => vi.advanceTimersByTime(101));
		expect(live.workspace.getState().drafts).toEqual({
			"session-command:new": { id: "new", text: "New session draft" },
		});
		unsubscribe();
	} finally {
		vi.useRealTimers();
	}
});
