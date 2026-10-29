import type { WorkspaceSnapshot } from "@octocodeai/octocode-contacts/workspace";
import { describe, expect, it, vi } from "vitest";
import { workspaceChanges, type RevisedWorkspace } from "../../src/octocode/workspace/revision.ts";

function workspace(revision: (() => string | undefined) | undefined) {
	let version = 0;
	const snapshot = vi.fn((): WorkspaceSnapshot => ({
		sessionId: "s",
		agents: [],
		traffic: [],
		events: [{ id: version, at: 0, type: "message", text: "" }],
		receipts: [],
	}));
	const connection: RevisedWorkspace = {
		snapshot,
		revision,
		execute: async () => {
			throw new Error("unused");
		},
		subscribe: () => () => undefined,
		close: () => undefined,
	};
	return { connection, snapshot, bump: () => version++ };
}

describe("workspaceChanges", () => {
	it("builds no snapshot while the stamp is unchanged", () => {
		let stamp = "1";
		const ws = workspace(() => stamp);
		const changed = workspaceChanges(ws.connection);
		expect(changed()).toBe(true);
		for (let tick = 0; tick < 10; tick++) expect(changed()).toBe(false);
		expect(ws.snapshot).toHaveBeenCalledTimes(1);

		ws.bump();
		stamp = "2";
		expect(changed()).toBe(true);
		expect(ws.snapshot).toHaveBeenCalledTimes(2);
		expect(changed()).toBe(false);
		expect(ws.snapshot).toHaveBeenCalledTimes(2);
	});

	it("sends nothing when the stamp moved but the snapshot is identical", () => {
		let stamp = "1";
		const ws = workspace(() => stamp);
		const changed = workspaceChanges(ws.connection);
		expect(changed()).toBe(true);
		stamp = "2";
		expect(changed()).toBe(false);
		expect(ws.snapshot).toHaveBeenCalledTimes(2);
	});

	it("compares serialized snapshots when no stamp is available", () => {
		const ws = workspace(undefined);
		const changed = workspaceChanges(ws.connection);
		expect(changed()).toBe(true);
		expect(changed()).toBe(false);
		ws.bump();
		expect(changed()).toBe(true);
		expect(ws.snapshot).toHaveBeenCalledTimes(3);
	});

	it("passes on a failure of the stamp or the snapshot", () => {
		const ws = workspace(() => {
			throw new Error("This session changed. Reopen /octocode.");
		});
		expect(() => workspaceChanges(ws.connection)()).toThrow("This session changed");
	});
});
