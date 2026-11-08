import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectionTone } from "../src/app/live/model.ts";
import { BrowserConnection } from "../src/transport.ts";

class Socket {
	static OPEN = 1;
	static instances: Socket[] = [];
	readyState = 1;
	onopen?: () => void;
	onmessage?: (event: { data: string }) => void;
	onclose?: ((event: { code: number }) => void) | null;
	onerror?: () => void;
	sent: string[] = [];
	closed: number[] = [];
	readonly url: string;
	constructor(url: string) {
		this.url = url;
		Socket.instances.push(this);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close(code = 1000) {
		this.closed.push(code);
		this.onclose?.({ code });
	}
	receive(data: unknown) {
		this.onmessage?.({ data: JSON.stringify(data) });
	}
}
const snapshot = {
	sessionId: "session-a",
	messages: [],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: ["prompt"],
};
const frame = (sequence: number, body: object) => ({
	type: "application",
	data: { protocolVersion: 1, cursor: { sessionId: "session-a", epoch: "epoch-a", sequence }, at: 0, ...body },
});
beforeEach(() => {
	vi.useFakeTimers();
	Socket.instances = [];
	vi.stubGlobal("WebSocket", Socket);
	vi.stubGlobal("location", { origin: "http://127.0.0.1:8080" });
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
function connection() {
	const observer = { application: vi.fn(), workspace: vi.fn(), profiler: vi.fn(), backlogs: vi.fn(), status: vi.fn() };
	const client = new BrowserConnection("secret", observer);
	client.open();
	return { client, observer, socket: Socket.instances[0] };
}
it("says the session keeps dropping the connection when several in a row close before any frame", () => {
	const { client, observer, socket } = connection();
	socket.close(1006);
	expect(connectionTone(observer.status.mock.lastCall![0])).toBe("connecting");
	for (const index of [1, 2]) {
		vi.runOnlyPendingTimers();
		Socket.instances[index].close(1006);
	}
	expect(connectionTone(observer.status.mock.lastCall![0])).toBe("error");
	// It keeps retrying, and a connection that delivers a frame starts the count again.
	vi.runOnlyPendingTimers();
	const recovered = Socket.instances[3];
	recovered.receive(frame(1, { type: "snapshot", snapshot }));
	recovered.close(1006);
	expect(connectionTone(observer.status.mock.lastCall![0])).toBe("connecting");
	client.close();
});

it("authenticates with protocol and replays the retained cursor after disconnection", () => {
	const { client, socket } = connection();
	socket.onopen?.();
	expect(JSON.parse(socket.sent[0])).toEqual({ token: "secret", protocolVersion: 1 });
	socket.receive(frame(4, { type: "snapshot", snapshot }));
	socket.close();
	vi.advanceTimersByTime(500);
	const resumed = Socket.instances[1];
	resumed.onopen?.();
	expect(JSON.parse(resumed.sent[0]).cursor).toEqual({ sessionId: "session-a", epoch: "epoch-a", sequence: 4 });
	client.close();
	vi.runAllTimers();
	expect(Socket.instances).toHaveLength(2);
});
it("reconnects without a cursor after a gap, and ignores late frames from detached sockets", () => {
	const { client, socket, observer } = connection();
	socket.receive(frame(4, { type: "snapshot", snapshot }));
	socket.receive(frame(6, { type: "event", event: { type: "run.started", runId: "run-a" } }));
	vi.advanceTimersByTime(500);
	const refreshed = Socket.instances[1];
	refreshed.onopen?.();
	expect(JSON.parse(refreshed.sent[0]).cursor).toBeUndefined();
	socket.receive(frame(7, { type: "snapshot", snapshot: { ...snapshot, streaming: true } }));
	expect(observer.application).toHaveBeenCalledTimes(1);
	refreshed.receive(frame(7, { type: "snapshot", snapshot }));
	expect(observer.application).toHaveBeenCalledTimes(2);
	client.close();
});
it("rejects malformed streams without retrying incompatible protocol forever", () => {
	const { client, socket } = connection();
	socket.receive({ type: "application", data: { protocolVersion: 999 } });
	expect(socket.closed).toEqual([1008]);
	vi.runAllTimers();
	expect(Socket.instances).toHaveLength(1);
	client.close();
});
it("does not cancel engine work on close and rejects stale-session commands before sending", async () => {
	const { client, socket } = connection();
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	socket.receive(frame(0, { type: "snapshot", snapshot }));
	await expect(
		client.execute({ id: "request-old", sessionId: "session-old", action: "prompt", text: "Hello" }),
	).rejects.toThrow("Session changed");
	client.close();
	expect(fetch).not.toHaveBeenCalled();
	expect(socket.sent).toHaveLength(0);
});

it("opens one socket at a time and reports connected only after an authenticated frame", () => {
	const { client, socket } = connection();
	client.open();
	expect(Socket.instances).toHaveLength(1);
	expect(client.connected).toBe(false);
	socket.onopen?.();
	expect(client.connected).toBe(false);
	socket.receive(frame(0, { type: "snapshot", snapshot }));
	expect(client.connected).toBe(true);
	socket.close();
	expect(client.connected).toBe(false);
	client.open();
	vi.advanceTimersByTime(500);
	expect(Socket.instances).toHaveLength(2);
	client.close();
});

it("ignores detached socket callbacks during the reconnect delay and after shutdown", () => {
	const { client, socket, observer } = connection();
	socket.receive(frame(0, { type: "snapshot", snapshot }));
	socket.close();
	socket.receive(frame(1, { type: "event", event: { type: "run.started", runId: "detached" } }));
	socket.onopen?.();
	expect(observer.application).toHaveBeenCalledOnce();
	expect(socket.sent).toEqual([]);
	expect(client.stream.snapshot?.streaming).toBe(false);
	client.close();
	vi.runAllTimers();
	expect(Socket.instances).toHaveLength(1);
});

it("ignores queued messages while a failed socket is closing before its close event", () => {
	const { client, socket, observer } = connection();
	socket.receive(frame(0, { type: "snapshot", snapshot }));
	const finishClose = socket.onclose;
	socket.onclose = null;
	socket.receive(frame(2, { type: "event", event: { type: "run.started", runId: "missed" } }));
	expect(client.connected).toBe(false);
	socket.receive(frame(3, { type: "snapshot", snapshot: { ...snapshot, streaming: true } }));
	socket.onopen?.();
	expect(observer.application).toHaveBeenCalledOnce();
	expect(client.stream.cursor).toBeUndefined();
	expect(socket.sent).toEqual([]);
	finishClose?.({ code: 1000 });
	vi.advanceTimersByTime(500);
	expect(Socket.instances).toHaveLength(2);
	client.close();
});

it("refuses new requests after close or while session state requires a fresh snapshot", async () => {
	const { client, socket } = connection();
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	const command = { id: "request", sessionId: "session-a", action: "prompt" as const, text: "Hello" };
	socket.receive(frame(0, { type: "snapshot", snapshot }));
	socket.receive(frame(2, { type: "event", event: { type: "run.started", runId: "missed" } }));
	await expect(client.execute(command)).rejects.toThrow("refreshing");
	client.close();
	await expect(client.execute(command)).rejects.toThrow("Connection closed");
	expect(fetch).not.toHaveBeenCalled();
});

it.each(["session", "epoch", "closed"])("does not merge a late HTTP receipt after %s changes", async (change) => {
	const { client, socket } = connection();
	socket.receive(frame(0, { type: "snapshot", snapshot }));
	const response = Promise.withResolvers<{ ok: boolean; json(): Promise<unknown> }>();
	vi.stubGlobal(
		"fetch",
		vi.fn(() => response.promise),
	);
	const pending = client.execute({ id: "request", sessionId: "session-a", action: "prompt", text: "Hello" });
	const rejection = expect(pending).rejects.toThrow("Session changed while the request was pending");
	if (change === "closed") client.close();
	else {
		const sessionId = change === "session" ? "session-b" : "session-a";
		socket.receive({
			type: "application",
			data: {
				...frame(0, {}).data,
				cursor: { sessionId, epoch: "epoch-new", sequence: 0 },
				type: "snapshot",
				snapshot: { ...snapshot, sessionId },
			},
		});
	}
	response.resolve({ ok: true, json: async () => ({ receipt: { id: "request", status: "accepted" } }) });
	await rejection;
	expect(client.stream.snapshot?.receipts).toEqual([]);
	client.close();
});

it.each([
	{ id: "different-request", status: "accepted" },
	{ id: "request", status: "accepted", message: { unsafe: "not text" } },
])("rejects a malformed or mismatched receipt %o", async (receipt) => {
	const { client, socket } = connection();
	socket.receive(frame(0, { type: "snapshot", snapshot }));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => ({ receipt }) })),
	);
	await expect(
		client.execute({ id: "request", sessionId: "session-a", action: "prompt", text: "Hello" }),
	).rejects.toThrow("Invalid command receipt");
	expect(client.stream.snapshot?.receipts).toEqual([]);
	client.close();
});

it("returns a streamed failure when an older HTTP acceptance arrives afterwards", async () => {
	const { client, socket } = connection();
	socket.receive(frame(0, { type: "snapshot", snapshot }));
	const response = Promise.withResolvers<Response>();
	vi.stubGlobal(
		"fetch",
		vi.fn(() => response.promise),
	);
	const pending = client.execute({ id: "request", sessionId: "session-a", action: "prompt", text: "Hello" });
	const failed = { id: "request", status: "failed", message: "Model unavailable" };
	socket.receive(frame(1, { type: "event", event: { type: "command.receipt", receipt: failed } }));
	response.resolve(new Response(JSON.stringify({ receipt: { id: "request", status: "accepted" } })));
	await expect(pending).resolves.toEqual(failed);
	client.close();
});

it("forwards a valid profiler frame to the observer and ignores a malformed one", () => {
	const { client, observer, socket } = connection();
	const update = {
		agent: {
			id: "main",
			role: "main",
			status: "idle",
			requests: 1,
			totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			profiled: true,
		},
		request: {
			agentId: "main",
			index: 0,
			at: 1,
			model: "m",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			layers: [],
			estimated: true,
		},
	};
	socket.receive({
		type: "profiler",
		data: { ...update, request: { ...update.request, layers: [{ kind: "bogus" }] } },
	});
	socket.receive({ type: "profiler", data: { agent: update.agent, events: [{ id: 1 }] } });
	expect(observer.profiler).not.toHaveBeenCalled();
	socket.receive({ type: "profiler", data: update });
	expect(observer.profiler).toHaveBeenCalledWith(update);
	// A frame may carry only the agent row and new events or messages.
	const eventsOnly = {
		agent: update.agent,
		events: [{ id: "main:tool:1", agentId: "main", kind: "tool", at: 1, label: "bash" }],
	};
	socket.receive({ type: "profiler", data: eventsOnly });
	expect(observer.profiler).toHaveBeenLastCalledWith(eventsOnly);
	client.close();
});
