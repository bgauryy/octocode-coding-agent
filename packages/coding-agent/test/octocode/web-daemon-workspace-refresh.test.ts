import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { WorkspaceSnapshot } from "@octocodeai/octocode-contracts/workspace";
import { TabHub } from "../../src/octocode/web-daemon/tabs.ts";

const hubs: TabHub[] = [];
afterEach(() => {
	for (const hub of hubs.splice(0)) hub.closeAll();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const state = (sessionId: string, message: string): WorkspaceSnapshot => ({
	sessionId,
	agents: [],
	traffic: [],
	receipts: [],
	events: [{ id: 1, at: 1, type: "agent", text: message }],
});

/** Inject already-authenticated transports so concurrency is exercised without binding a socket. */
function fixture() {
	const hub = new TabHub({
		tokens: { launch: "launch", remote: "remote", view: "view" },
		origin: () => "http://127.0.0.1:3210",
		catalog: {} as never,
		env: { OCTOCODE_AGENT_DB: "/tmp/octocode-web-refresh-no-database.db" },
		activity: () => {},
		accepting: () => true,
	});
	hubs.push(hub);
	const internal = hub as unknown as { tabs: Set<unknown>; check(): Promise<void> };
	const add = (id: string) => {
		const workspace = {
			revision: vi.fn(async (): Promise<string | null> => "1"),
			snapshot: vi.fn(async () => state(id, "initial")),
		};
		const socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: vi.fn(), terminate: vi.fn() };
		internal.tabs.add({
			socket,
			scope: { repo: { id: "repo", name: "repo" }, session: { id, client: { connected: true, workspace } } },
			access: "control",
		});
		return { workspace, socket };
	};
	return { hub, add, check: () => internal.check() };
}

describe("daemon workspace refresh ordering", () => {
	it("serializes overlapping updates and coalesces bursts without publishing an older result last", async () => {
		const app = fixture();
		const { workspace, socket } = app.add("s");
		const first = deferred<WorkspaceSnapshot>();
		workspace.snapshot.mockImplementationOnce(() => first.promise).mockResolvedValue(state("s", "latest"));
		const initial = app.hub.workspaceChanged("s");
		await vi.waitFor(() => expect(workspace.snapshot).toHaveBeenCalledTimes(1));
		workspace.revision.mockResolvedValue("2");
		const updates = Array.from({ length: 20 }, () => app.hub.workspaceChanged("s", true));
		await Promise.resolve();
		expect(workspace.snapshot).toHaveBeenCalledTimes(1);
		first.resolve(state("s", "older"));
		await Promise.all([initial, ...updates]);
		await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(2));
		expect(workspace.snapshot).toHaveBeenCalledTimes(2);
		expect(socket.send.mock.calls.map(([text]) => JSON.parse(text).data.events[0].text)).toEqual(["older", "latest"]);
	});

	it("refreshes another session while one session is slow", async () => {
		const app = fixture();
		const slow = app.add("slow");
		const fast = app.add("fast");
		const pending = deferred<WorkspaceSnapshot>();
		slow.workspace.snapshot.mockReturnValue(pending.promise);
		const checked = app.check();
		await vi.waitFor(() => expect(fast.socket.send).toHaveBeenCalledTimes(1));
		pending.resolve(state("slow", "finished"));
		await checked;
	});

	it("allows retries after a rejected refresh", async () => {
		const app = fixture();
		const { workspace, socket } = app.add("s");
		workspace.snapshot.mockRejectedValueOnce(new Error("disconnected"));
		await expect(app.hub.workspaceChanged("s")).rejects.toThrow("disconnected");
		await app.hub.workspaceChanged("s");
		expect(socket.send).toHaveBeenCalledTimes(1);
	});
});
