import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "@octocodeai/octocode-contracts/workspace";
import { createSessionDrafts, type SessionDraftStorage } from "../src/session-drafts.ts";
import { createWorkspaceStore } from "../src/state.ts";

function storage(): SessionDraftStorage & { values: Map<string, string> } {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
		removeItem: (key) => {
			values.delete(key);
		},
	};
}
const draft = (text: string, to = "prompt") => ({ id: "request-id-not-persisted", text, to });

describe("per-tab session composer drafts", () => {
	it("restores independent sessions across navigation and reload with only text and mode", () => {
		const tab = storage(),
			first = createWorkspaceStore(tab),
			second = createWorkspaceStore(tab);
		first.getState().setDraft("session-command:session-a", {
			...draft("Keep A", "steer"),
			attachments: [{ id: "asset-token", name: "private.png", mimeType: "image/png", size: 1 }],
		});
		second.getState().setDraft("session-command:session-b", draft("Keep B", "followUp"));
		first.getState().setDraft("session-sent:session-a:request", draft("Do not persist sent receipts"));
		const restored = createWorkspaceStore(tab).getState().drafts;
		expect(restored["session-command:session-a"]).toMatchObject({ text: "Keep A", to: "steer" });
		expect(restored["session-command:session-b"]).toMatchObject({ text: "Keep B", to: "followUp" });
		expect(restored["session-command:session-a"].attachments).toBeUndefined();
		expect(restored["session-sent:session-a:request"]).toBeUndefined();
		const saved = [...tab.values.values()].join("");
		expect(saved).not.toContain("asset-token");
		expect(saved).not.toContain("request-id-not-persisted");
	});
	it("hydrates only the destination session while keeping other drafts for a later return", () => {
		const tab = storage(),
			store = createWorkspaceStore(tab);
		const snapshot = (sessionId: string): WorkspaceSnapshot => ({
			sessionId,
			agents: [],
			traffic: [],
			receipts: [],
			events: [],
		});
		store.getState().accept(snapshot("a"));
		store.getState().setDraft("session-command:a", draft("Draft A"));
		store.getState().accept(snapshot("b"));
		expect(store.getState().drafts).toEqual({});
		store.getState().setDraft("session-command:b", draft("Draft B"));
		store.getState().accept(snapshot("a"));
		expect(Object.keys(store.getState().drafts)).toEqual(["session-command:a"]);
		expect(store.getState().drafts["session-command:a"].text).toBe("Draft A");
		store.getState().accept(snapshot("b"));
		expect(Object.keys(store.getState().drafts)).toEqual(["session-command:b"]);
		expect(store.getState().drafts["session-command:b"].text).toBe("Draft B");
		expect(Object.keys(createSessionDrafts(tab).read())).toEqual(["session-command:a", "session-command:b"]);
	});

	it("removes only the sent, deleted or emptied session draft", () => {
		const tab = storage(),
			store = createWorkspaceStore(tab);
		store.getState().setDraft("session-command:a", draft("Keep A"));
		store.getState().setDraft("session-command:b", draft("Keep B"));
		store.getState().setDraft("session-command:a", null);
		expect(createWorkspaceStore(tab).getState().drafts["session-command:a"]).toBeUndefined();
		expect(createWorkspaceStore(tab).getState().drafts["session-command:b"].text).toBe("Keep B");
		store.getState().setDraft("session-command:b", draft("   "));
		expect(tab.values.size).toBe(0);
	});
	it("keeps editing usable if storage is unavailable or full", () => {
		const unavailable = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("quota");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
		};
		const store = createWorkspaceStore(unavailable);
		expect(() => store.getState().setDraft("session-command:a", draft("Still editable"))).not.toThrow();
		expect(store.getState().drafts["session-command:a"].text).toBe("Still editable");
		const full = storage();
		full.setItem = vi.fn(() => {
			throw new Error("quota");
		});
		const other = createWorkspaceStore(full);
		other.getState().setDraft("session-command:a", draft("Still usable"));
		expect(other.getState().drafts["session-command:a"].text).toBe("Still usable");
	});
	it("bounds retained sessions and total text without truncating an oversized in-memory draft", () => {
		const tab = storage(),
			store = createWorkspaceStore(tab);
		for (let n = 0; n < 12; n++) store.getState().setDraft(`session-command:s${n}`, draft(`Draft ${n}`));
		expect(Object.keys(createWorkspaceStore(tab).getState().drafts)).toHaveLength(10);
		expect(createWorkspaceStore(tab).getState().drafts["session-command:s0"]).toBeUndefined();
		const large = "x".repeat(64 * 1024);
		for (let n = 0; n < 8; n++) store.getState().setDraft(`session-command:l${n}`, draft(large));
		const retained = Object.values(createWorkspaceStore(tab).getState().drafts);
		expect(retained.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(256 * 1024);
		const oversized = large + "x";
		store.getState().setDraft("session-command:l7", draft(oversized));
		expect(store.getState().drafts["session-command:l7"].text).toBe(oversized);
		expect(createWorkspaceStore(tab).getState().drafts["session-command:l7"]).toBeUndefined();
	});
	it("ignores malformed storage and invalid modes", () => {
		const tab = storage();
		const key = "octocode-session-drafts-v1";
		tab.setItem(key, "not json");
		expect(createSessionDrafts(tab).read()).toEqual({});
		tab.setItem(key, JSON.stringify([["a", { text: "safe", to: "invalid", attachments: ["never"] }]]));
		expect(createSessionDrafts(tab).read()["session-command:a"]).toMatchObject({ text: "safe" });
		expect(createSessionDrafts(tab).read()["session-command:a"].to).toBeUndefined();
	});
});
