/** @vitest-environment jsdom */
import type { BacklogTask, TaskState } from "@octocodeai/octocode-contracts/backlogs";
import type { Snapshot } from "@octocodeai/octocode-contracts/snapshot";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { ConnectionStatus, LiveProvider } from "../src/app/live/session.tsx";
import { sessionTaskProgress } from "../src/app/model/hierarchy.ts";
import { FakeSocket, snapshotItem } from "./helpers.ts";

function task(seq: number, state: TaskState, owner: BacklogTask["owner"]): BacklogTask {
	return {
		ref: `T${seq}`,
		seq,
		rowId: seq,
		goal: `Step ${seq}`,
		state,
		owner,
		reason: "",
		result: "",
		position: seq,
		version: 1,
		createdAt: 0,
		updatedAt: 0,
	};
}
const snapshot: Snapshot = {
	repo: "repo",
	generatedAt: 1,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 1000,
	items: [
		snapshotItem("B1", {
			state: "ongoing",
			assignee: "main",
			tasks: [task(1, "done", { kind: "item", ref: "B1" }), task(2, "todo", { kind: "item", ref: "B1" })],
		}),
		snapshotItem("B2", { state: "ongoing", assignee: "other", tasks: [task(3, "done", { kind: "item", ref: "B2" })] }),
		snapshotItem("B3", { state: "done", assignee: "main", tasks: [task(4, "done", { kind: "item", ref: "B3" })] }),
	],
	sessionTasks: [
		task(5, "dropped", { kind: "session", id: "main" }),
		task(6, "done", { kind: "session", id: "other" }),
	],
};
afterEach(() => vi.unstubAllGlobals());

it("counts only the selected session's own steps and ongoing items, keeping dropped separate", () => {
	expect(sessionTaskProgress(snapshot, "main")).toBe("Steps 1/3 done · 1 dropped");
	expect(sessionTaskProgress(snapshot, "other")).toBe("Steps 2/2 done");
	expect(sessionTaskProgress(snapshot, "unknown")).toBe("");
	expect(sessionTaskProgress(snapshot, undefined)).toBe("");
});

it("updates the web header from pushed steps and scopes it again when the session changes", async () => {
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	const backlog = createBacklogStore(snapshot);
	render(
		<LiveProvider access="token" backlog={backlog}>
			<ConnectionStatus />
		</LiveProvider>,
	);
	expect(screen.queryByRole("link", { name: /Steps/ })).toBeNull();
	const workspace = (sessionId: string) => ({ sessionId, agents: [], traffic: [], events: [], receipts: [] });
	act(() => FakeSocket.instances[0].receive("workspace", workspace("main")));
	const progress = await screen.findByRole("link", { name: "Steps 1/3 done · 1 dropped" });
	expect(progress).toHaveAttribute("href", "#tree");
	act(() =>
		FakeSocket.instances[0].receive("snapshot", {
			...snapshot,
			items: snapshot.items.map((item) =>
				item.ref === "B1" ? { ...item, tasks: item.tasks?.map((step) => ({ ...step, state: "done" })) } : item,
			),
		}),
	);
	expect(await screen.findByRole("link", { name: "Steps 2/3 done · 1 dropped" })).toHaveAttribute(
		"title",
		"This session's checklist progress",
	);
	// Switching the selected workspace discards the previous session's progress immediately on publication.
	act(() => FakeSocket.instances[0].receive("workspace", workspace("other")));
	await waitFor(() => expect(screen.getByRole("link", { name: /Steps/ })).toHaveTextContent("Steps 2/2 done"));
	act(() => FakeSocket.instances[0].close(1008));
	expect(screen.getByRole("link", { name: /Steps/ })).toHaveAttribute("title", "Cached checklist progress");
});
