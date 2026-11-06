/** @vitest-environment jsdom */
import type { Snapshot } from "@octocodeai/octocode-contracts/snapshot";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonScopedApp } from "../src/app/daemon/ScopedApp.tsx";
import { daemonLive } from "../src/app/daemon/live.ts";
import { createBacklogStore } from "../src/app/extension.ts";
import { live } from "../src/app/live/index.ts";
import { FakeSocket, snapshotItem } from "./helpers.ts";

const snapshot: Snapshot = {
	repo: "repo",
	generatedAt: 1000,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 100_000,
	items: [snapshotItem("B1", { title: "Fix the save bug", state: "todo", goal: "Saving works" })],
};
const fetchMock = vi.fn<typeof fetch>();
const answerAccess = (reply: () => Response | Promise<Response>) =>
	fetchMock.mockImplementation(async (input) =>
		String(input).endsWith("/api/access") ? reply() : new Response("{}", { status: 200 }),
	);
const page = (kind: "repo" | "session") => {
	if (!live) throw new Error("live extension");
	return <DaemonScopedApp backlog={createBacklogStore(snapshot)} live={live} scope={{ kind, id: "x" }} access="tok" />;
};

beforeEach(() => {
	FakeSocket.instances = [];
	fetchMock.mockReset();
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", fetchMock);
	history.replaceState(null, "", "#board");
});
afterEach(() => vi.unstubAllGlobals());

describe("daemon page access", () => {
	it("hides edit controls until the daemon says the token may write, then offers them", async () => {
		answerAccess(() => Response.json({ writable: true }));
		render(page("repo"));
		expect(screen.queryByRole("button", { name: /New item/ })).toBeNull();
		expect(await screen.findByRole("button", { name: /New item/ })).toBeInTheDocument();
		expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/access")).toBe(true);
	});

	it("keeps a view token's page read-only", async () => {
		answerAccess(() => Response.json({ writable: false }));
		render(page("repo"));
		await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/access")).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.queryByRole("button", { name: /New item/ })).toBeNull();
	});

	it("stays read-only when the daemon cannot answer (an older daemon has no such route)", async () => {
		answerAccess(() => Response.json({ error: "Not found" }, { status: 404 }));
		render(page("session"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.queryByRole("button", { name: /New item/ })).toBeNull();
	});
});

describe("daemonLive access", () => {
	it("derives read-only from the daemon's answer, and from the scope when it is unknown", () => {
		if (!live) throw new Error("live extension");
		expect(daemonLive(live, { kind: "repo", id: "r" }, true).readOnly).toBeUndefined();
		expect(daemonLive(live, { kind: "repo", id: "r" }, false).readOnly).toBe(true);
		expect(daemonLive(live, { kind: "repo", id: "r" }).readOnly).toBe(true);
		expect(daemonLive(live, { kind: "session", id: "s" }, false).readOnly).toBe(true);
		expect(daemonLive(live, { kind: "session", id: "s" }).readOnly).toBeUndefined();
		expect(daemonLive(live, { kind: "repo", id: "r" }, true).views.map((view) => view.name)).toEqual([
			"rfc",
			"research",
			"audit",
		]);
	});
});
