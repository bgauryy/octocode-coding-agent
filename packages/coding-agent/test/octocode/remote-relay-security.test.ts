import { describe, expect, it, vi } from "vitest";
import { startWebDaemon } from "../../src/octocode/web-daemon/main.ts";
import {
	parseTunnelRequest,
	parseWire,
	relayHostUrl,
	validPath,
} from "../../src/octocode/web-daemon/remote/protocol.ts";
import { PeerTunnel } from "../../src/octocode/web-daemon/remote/tunnel.ts";
import { cleanup, pageOver, publishOn, publishRelay } from "./remote-page-fixture.ts";
import { isolatedEnv } from "./web-daemon-fixture.ts";

const answer = (page: ReturnType<typeof pageOver>, id: string) => page.received.find((m) => m.id === id);

describe("relay peers cannot reuse each other's frames (wire v1)", () => {
	it("refuses frames recorded from one peer when replayed through a new peer, and closes it", async () => {
		const { relay, key, room, server } = await publishRelay("control");
		const first = pageOver(await relay.peer(room), key);
		await first.send({ kind: "request", id: "a", method: "GET", path: "/api/sessions" });
		await vi.waitFor(() => expect(answer(first, "a")?.status).toBe(200));

		// A new peer joins and completes its own handshake; the recorded frame is sealed for the first peer's keys.
		const second = pageOver(await relay.peer(room), key);
		await second.ready;
		second.sendRaw(first.sent[0]);
		expect(await second.closed).toBe(1000);
		expect(second.received.some((m) => m.id === "a")).toBe(false);

		// Even with the same page nonce the daemon's fresh nonce changes both keys.
		const nonce = new Uint8Array(16).fill(7);
		const third = pageOver(await relay.peer(room), key, { nonce });
		await third.ready;
		await third.send({ kind: "request", id: "t", method: "GET", path: "/api/sessions" });
		await vi.waitFor(() => expect(answer(third, "t")?.status).toBe(200));
		const fourth = pageOver(await relay.peer(room), key, { nonce });
		await fourth.ready;
		fourth.sendRaw(third.sent[0]);
		expect(await fourth.closed).toBe(1000);

		// A sealed frame before any handshake is refused as well.
		const early = pageOver(await relay.peer(room), key, { join: false });
		early.sendRaw(first.sent[0]);
		expect(await early.closed).toBe(1000);
		expect(server.remote.status().relay?.state).toBe("connected");
	});

	it("refuses unversioned, old and malformed frames", async () => {
		const { relay, room } = await publishRelay("view");
		const nonce = Buffer.alloc(16, 1).toString("base64url");
		for (const frame of [
			"garbage",
			Buffer.alloc(40).toString("base64"),
			JSON.stringify({ t: "join", nonce }),
			JSON.stringify({ v: 2, t: "join", nonce }),
			JSON.stringify({ v: 1, t: "join", nonce: "short" }),
			JSON.stringify({ v: 1, t: "hello", nonce }),
			JSON.stringify({ v: 1, t: "msg", s: -1, d: "AAAA" }),
		]) {
			const socket = await relay.peer(room);
			const closed = new Promise<number>((resolve) => socket.on("close", resolve));
			socket.send(frame);
			expect(await closed).toBe(1000);
		}
		expect(parseWire(JSON.stringify({ v: 1, t: "join", nonce }))).toMatchObject({ t: "join" });
	});

	it("drops a peer that never answers the daemon's hello", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		try {
			const { relay, room, server } = await publishRelay("view");
			const socket = await relay.peer(room);
			const closed = new Promise<number>((resolve) => socket.on("close", resolve));
			await vi.waitFor(() => expect(server.remote.status().relay?.peers).toBe(1), { interval: 5 });
			vi.advanceTimersByTime(10_001);
			expect(await closed).toBe(1000);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a peer cannot wedge a room with an invalid path", () => {
	it("answers an error for a NUL or non-ASCII path and still serves the next request", async () => {
		const { relay, key, room, server } = await publishRelay("view");
		const page = pageOver(await relay.peer(room), key);
		const bad = ["/api/a\u0000b", "/api/a€b", "/api/a b", "/api/a\r\nHost: x", "/a\\b", "/a#b"];
		for (const [index, path] of bad.entries())
			await page.send({ kind: "request", id: `bad${index}`, method: "GET", path });
		await page.send({ kind: "stream.open", stream: "bad", path: "/s/x\u0000/live" });
		await page.send({ kind: "request", id: "good", method: "GET", path: "/api/sessions" });
		await vi.waitFor(() => expect(answer(page, "good")?.status).toBe(200));
		for (let index = 0; index < bad.length; index++) expect(answer(page, `bad${index}`)?.status).toBe(400);
		expect(page.received.find((m) => m.kind === "stream.end" && m.stream === "bad")).toMatchObject({ code: 1008 });
		expect(server.remote.status().relay).toMatchObject({ state: "connected", peers: 1 });
	});

	it("keeps its request slots when Node refuses a request synchronously", async () => {
		const sent: Array<Record<string, unknown>> = [];
		// A port Node rejects before sending: the throw must release the slot and tell the peer.
		const tunnel = new PeerTunnel({ port: -1, origin: "http://127.0.0.1:1", token: "t" }, (m) => sent.push(m));
		for (let index = 0; index < 40; index++)
			tunnel.handle({ kind: "request", id: `r${index}`, method: "GET", path: "/api/sessions" });
		expect(sent).toHaveLength(40);
		expect(sent.every((m) => m.kind === "response" && m.status === 400)).toBe(true);
	});

	it("admits only RFC 3986 characters in a target", () => {
		const request = (path: string) =>
			parseTunnelRequest(JSON.stringify({ kind: "request", id: "r", method: "GET", path }));
		for (const path of ["/", "/api/sessions?x=a%20b&y=c:d@e", "/s/id/api/a-b_c.d~e!$&'()*+,;="])
			expect(validPath(path)).toBe(true);
		for (const path of [
			"//evil",
			"x",
			"/a b",
			"/a\u0000",
			"/aé",
			"/a%zz",
			"/a%2",
			"/a\\b",
			"/a#b",
			'/a"b',
			`/${"a".repeat(2049)}`,
		])
			expect(validPath(path)).toBe(false);
		// The parser keeps an invalid target so the tunnel can answer it; the shape of the message is still checked.
		expect(request("/a\u0000")).toMatchObject({ kind: "request" });
		expect(
			parseTunnelRequest(JSON.stringify({ kind: "request", id: "bad id", method: "GET", path: "/" })),
		).toBeUndefined();
	});
});

describe("a control link reaches the page, not the admin routes", () => {
	it("lets a relay control peer use session routes and answers 403 on drain and remote administration", async () => {
		const { relay, key, room, server } = await publishRelay("control");
		const page = pageOver(await relay.peer(room), key);
		await page.send({ kind: "request", id: "s", method: "GET", path: "/api/sessions" });
		await page.send({ kind: "request", id: "cmd", method: "POST", path: "/s/missing/api/application", body: "{}" });
		await page.send({ kind: "request", id: "drain", method: "POST", path: "/api/admin/drain" });
		await page.send({ kind: "request", id: "pub", method: "POST", path: "/api/admin/remote", body: "{}" });
		await page.send({ kind: "request", id: "list", method: "GET", path: "/api/admin/remote" });
		await vi.waitFor(() => expect(answer(page, "list")).toBeDefined());
		expect(answer(page, "s")?.status).toBe(200);
		// Not 403: a view room would be refused; the control room reaches the session lookup.
		expect(answer(page, "cmd")?.status).toBe(404);
		for (const id of ["drain", "pub", "list"]) expect(answer(page, id)?.status).toBe(403);
		expect(server.draining).toBe(false);
	});
});

describe("a relay under a path prefix", () => {
	it("builds the host URL on the prefix, whatever its trailing slash or query", () => {
		const room = "0123456789abcdef0123456789abcdef";
		expect(relayHostUrl("wss://host/octo", room)).toBe(`wss://host/octo/v1/rooms/${room}/host`);
		expect(relayHostUrl("wss://host/octo/", room)).toBe(`wss://host/octo/v1/rooms/${room}/host`);
		expect(relayHostUrl("wss://host/octo?x=1", room)).toBe(`wss://host/octo/v1/rooms/${room}/host`);
		expect(relayHostUrl("ws://127.0.0.1:8080/", room)).toBe(`ws://127.0.0.1:8080/v1/rooms/${room}/host`);
	});

	it("dials the room below the prefix and publishes a page link under the same prefix", async () => {
		const { relay, link, room, server } = await publishRelay("view", { prefix: "/octo" });
		expect(relay.url.endsWith("/octo")).toBe(true);
		expect(link.pathname).toBe("/octo/");
		expect(relay.rooms.get(room)?.host).toBeDefined();
		expect(server.remote.status().relay).toMatchObject({ state: "connected" });
	});
});

describe("idle exit", () => {
	it("does not exit while a device is connected through a relay, and exits after it leaves", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "0.02" });
		const running = await startWebDaemon(env);
		expect(running).toBeDefined();
		cleanup.push(() => running!.shutdown());
		const { relay, key, room } = await publishOn(running!.server, "view");
		const page = pageOver(await relay.peer(room), key);
		await page.ready;
		let exited = false;
		void running!.stopped.then(() => (exited = true));
		// 0.02 minutes is 1.2 s: well past it, the daemon still runs because a device is connected.
		await new Promise((resolve) => setTimeout(resolve, 2500));
		expect(exited).toBe(false);
		page.sendRaw("leave");
		await page.closed;
		await vi.waitFor(() => expect(exited).toBe(true), { timeout: 6000, interval: 100 });
	});
});
