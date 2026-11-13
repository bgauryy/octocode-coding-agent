import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import {
	acquireWebSocket,
	getOpenAICodexWebSocketDebugStats,
	isWebSocketSseFallbackActive,
	recordWebSocketFailure,
	resetOpenAICodexWebSocketDebugStats,
} from "../src/api/openai-codex-responses/websocket-session.ts";

class MockSocket extends EventTarget {
	static instances: MockSocket[] = [];
	static autoOpen = true;
	readyState = 0;
	sent = 0;
	constructor() {
		super();
		MockSocket.instances.push(this);
		if (MockSocket.autoOpen) queueMicrotask(() => this.open());
	}
	open() {
		if (this.readyState === 3) return;
		this.readyState = 1;
		this.dispatchEvent(new Event("open"));
	}
	close() {
		this.readyState = 3;
		this.dispatchEvent(new Event("close"));
	}
	send() {
		this.sent++;
	}
}

const acquire = (sessionId = "session") =>
	acquireWebSocket("wss://test.invalid", new Headers(), sessionId, "account", undefined, 1000, {});

afterEach(() => {
	cleanupSessionResources();
	resetOpenAICodexWebSocketDebugStats();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	MockSocket.instances = [];
	MockSocket.autoOpen = true;
});

describe("Codex session resource ownership", () => {
	it("keeps ownership of overlapping first connections until their release", async () => {
		vi.stubGlobal("WebSocket", MockSocket);
		const leases = await Promise.all([acquire(), acquire()]);
		for (const lease of leases) lease.release({ keep: true });
		expect(MockSocket.instances.filter((socket) => socket.readyState === 1)).toHaveLength(1);
		cleanupSessionResources("session");
		expect(MockSocket.instances.every((socket) => socket.readyState === 3)).toBe(true);
	});

	it("does not keep Node alive solely for an idle cached socket timer", async () => {
		vi.stubGlobal("WebSocket", MockSocket);
		const lease = await acquire();
		const timers = vi.spyOn(globalThis, "setTimeout");
		lease.release({ keep: true });
		const timer = timers.mock.results.at(-1)?.value as NodeJS.Timeout;
		expect(timer.hasRef()).toBe(false);
	});

	it("closes uncached parallel connections when their session ends", async () => {
		vi.stubGlobal("WebSocket", MockSocket);
		const first = await acquire();
		const parallel = await acquire();
		cleanupSessionResources("session");
		expect(MockSocket.instances.every((socket) => socket.readyState === 3)).toBe(true);
		first.release();
		parallel.release();
	});

	it("closes a pending connection when its session ends", async () => {
		vi.stubGlobal("WebSocket", MockSocket);
		MockSocket.autoOpen = false;
		const pending = acquire().then(
			(lease) => ({ lease, error: undefined }),
			(error: unknown) => ({ lease: undefined, error }),
		);
		await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
		cleanupSessionResources("session");
		const stateAfterCleanup = MockSocket.instances[0].readyState;
		MockSocket.instances[0].open();
		const result = await pending;
		result.lease?.release();
		expect(stateAfterCleanup).toBe(3);
		expect(result.error).toMatchObject({ name: "AbortError" });
	});

	it("does not acquire a cached connection after cancellation", async () => {
		vi.stubGlobal("WebSocket", MockSocket);
		(await acquire()).release({ keep: true });
		const controller = new AbortController();
		controller.abort(new Error("already stopped"));
		const result = await acquireWebSocket(
			"wss://test.invalid",
			new Headers(),
			"session",
			"account",
			controller.signal,
			1000,
			{},
		).then(
			(lease) => {
				lease.release({ keep: true });
				return undefined;
			},
			(error: unknown) => error,
		);
		expect(result).toMatchObject({ name: "AbortError" });
		expect(MockSocket.instances).toHaveLength(1);
	});

	it("releases diagnostics and fallback state only for the ended session", () => {
		recordWebSocketFailure("session", new Error("transport failed"));
		recordWebSocketFailure("other", new Error("other failed"));
		cleanupSessionResources("session");
		expect(getOpenAICodexWebSocketDebugStats("session")).toBeUndefined();
		expect(isWebSocketSseFallbackActive("session")).toBe(false);
		expect(getOpenAICodexWebSocketDebugStats("other")?.websocketFailures).toBe(1);
		expect(isWebSocketSseFallbackActive("other")).toBe(true);
	});

	it.each([
		["connecting", "short"],
		["active", "short"],
		["started", "short"],
		["active", "none"],
		["connecting", "none"],
	] as const)("does not retry %s session cleanup over SSE with %s caching", async (phase, cacheRetention) => {
		vi.stubGlobal("WebSocket", MockSocket);
		MockSocket.autoOpen = phase !== "connecting";
		const fetch = vi.fn(async () => new Response("unexpected fallback", { status: 500 }));
		const onProviderStreamEvent = vi.fn();
		const model: Model<"openai-codex-responses"> = {
			id: "test",
			name: "test",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://test.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }));
		const response = stream(model, normalizeContext({ messages: [] }), {
			apiKey: `header.${payload.toString("base64url")}.signature`,
			sessionId: "session",
			fetch,
			onProviderStreamEvent,
			cacheRetention,
			env: {},
		}).result();
		await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
		if (phase !== "connecting") await vi.waitFor(() => expect(MockSocket.instances[0].sent).toBe(1));
		if (phase === "started") {
			MockSocket.instances[0].dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ type: "response.created", response: { id: "r", status: "in_progress" } }),
				}),
			);
			await vi.waitFor(() => expect(onProviderStreamEvent).toHaveBeenCalled());
		}
		cleanupSessionResources("session");
		expect((await response).stopReason).toBe("aborted");
		expect(fetch).not.toHaveBeenCalled();
		expect(getOpenAICodexWebSocketDebugStats("session")).toBeUndefined();
	});
});
