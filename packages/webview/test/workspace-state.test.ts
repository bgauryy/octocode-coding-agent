import type { WorkspaceSnapshot } from "@octocodeai/octocode-contracts/workspace";
import { createWorkspaceStore, selectEvents } from "@octocodeai/octocode-webview/state";
import { describe, expect, it } from "vitest";

const snapshot = (types: string[]): WorkspaceSnapshot => ({
	sessionId: "s",
	agents: [],
	traffic: [],
	receipts: [],
	events: types.map((type, id) => ({ id, at: id, type, text: type })),
});
describe("workspace browser state", () => {
	it("freezes the reading feed while continuing to receive agent updates, then catches up", () => {
		const store = createWorkspaceStore();
		store.getState().accept(snapshot(["tool.start"]));
		store.getState().setPaused(true);
		const frozen = store.getState().displayedEvents;
		store.getState().accept(snapshot(["tool.start", "tool.result"]));
		expect(store.getState().displayedEvents).toBe(frozen);
		expect(store.getState().snapshot?.events).toHaveLength(2);
		store.getState().setPaused(false);
		expect(selectEvents(store.getState()).map((event) => event.type)).toEqual(["tool.result", "tool.start"]);
	});
	it("preserves event identity for the same reference and equal content but publishes changed content", () => {
		const store = createWorkspaceStore();
		const initial = snapshot(["message"]);
		store.getState().accept(initial);
		store.getState().accept({ ...initial });
		expect(store.getState().displayedEvents).toBe(initial.events);
		const equivalent = snapshot(["message"]);
		store.getState().accept(equivalent);
		expect(store.getState().displayedEvents).toBe(initial.events);
		expect(store.getState().snapshot).toBe(equivalent);
		const changed = { ...equivalent, events: [{ ...equivalent.events[0], text: "updated" }] };
		store.getState().accept(changed);
		expect(store.getState().displayedEvents).toBe(changed.events);
	});

	it("session changes reset a paused feed instead of retaining events from the previous session", () => {
		const store = createWorkspaceStore();
		store.getState().accept(snapshot(["message"]));
		store.getState().setPaused(true);
		const next = { ...snapshot(["tool.start"]), sessionId: "next" };
		store.getState().accept(next);
		expect(store.getState().paused).toBe(false);
		expect(store.getState().displayedEvents).toBe(next.events);
	});

	it("retains filters across snapshots and keeps separate views isolated", () => {
		const store = createWorkspaceStore();
		store.getState().setFilter("results");
		store.getState().accept(snapshot(["tool.start", "tool.result", "agent.result", "message"]));
		expect(selectEvents(store.getState()).map((event) => event.type)).toEqual(["agent.result", "tool.result"]);
		expect(createWorkspaceStore().getState().snapshot).toBeNull();
	});
	it("keeps identical event snapshots stable and clears drafts when the session changes", () => {
		const store = createWorkspaceStore();
		store.getState().accept(snapshot(["message"]));
		const events = store.getState().displayedEvents;
		store.getState().setDraft("comment:B1", { id: "draft", text: "Keep this context" });
		store.getState().setRequest("work:B1:1", { id: "request", status: "accepted", message: "Queued" });
		store.getState().accept(snapshot(["message"]));
		expect(store.getState().displayedEvents).toBe(events);
		expect(store.getState().drafts["comment:B1"].text).toBe("Keep this context");
		expect(store.getState().requests["work:B1:1"].id).toBe("request");
		store.getState().accept({ ...snapshot([]), sessionId: "different" });
		expect(store.getState().drafts).toEqual({});
		expect(store.getState().requests).toEqual({});
	});
});
