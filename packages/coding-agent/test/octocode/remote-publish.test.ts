import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { Value } from "typebox/value";
import { RemoteStatusSchema } from "@octocodeai/octocode-contacts/daemon";
import { sharedAgentDb } from "../../src/octocode/agentdb/db.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { relayPageUrl, validRelayUrl } from "../../src/octocode/web-daemon/remote/publisher.ts";
import { decodeKey, open, roomOf, seal } from "../../src/octocode/web-daemon/remote/seal.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { repoId } from "../../src/octocode/web-daemon/sessions.ts";
import { startRelayFixture } from "./remote-relay-fixture.ts";
import { isolatedEnv } from "./web-daemon-fixture.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

const REPO_KEY = "/work/demo/.git";

async function daemon() {
	const { env } = isolatedEnv();
	const server: DaemonServer = await startDaemonServer({
		env,
		onActivity: () => {},
		config: async () => ({ protocolVersion: 1, providers: [] }),
		onDrain: () => {},
	});
	cleanup.push(() => server.close());
	const origin = `http://127.0.0.1:${server.port}`;
	const call = (token: string, method: string, body?: unknown) =>
		fetch(origin + "/api/admin/remote", {
			method,
			headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	new BacklogStore(() => sharedAgentDb(env), REPO_KEY).add(
		{ title: "Daemon item", goal: "Seen remotely", createdBy: "tester" },
		{ id: "tester" },
	);
	return { env, server, origin, call };
}

/** A page's side of a relay room: sealed tunnel messages in, sealed answers out. */
function pageOver(socket: WebSocket, key: Buffer) {
	const room = roomOf(key);
	const received: Array<Record<string, unknown>> = [];
	socket.on("message", (data) => {
		const plain = open(key, room, String(data));
		if (plain !== undefined) received.push(JSON.parse(plain));
	});
	let seq = 0;
	return {
		received,
		send: (message: Record<string, unknown>) =>
			socket.send(seal(key, room, JSON.stringify({ seq: seq++, ...message }))),
		sendRaw: (text: string) => socket.send(text),
		closed: new Promise<number>((resolve) => socket.on("close", (code) => resolve(code))),
	};
}

describe("remote publication", () => {
	it("issues ssh links with the daemon's own tokens behind a port forward, and only to the control token", async () => {
		const { server, call } = await daemon();
		expect((await call(server.viewToken, "GET")).status).toBe(403);
		expect((await call(server.viewToken, "POST", { transport: "ssh", access: "view" })).status).toBe(403);
		const control = await (await call(server.token, "POST", { transport: "ssh", access: "control" })).json();
		expect(control.link).toMatchObject({
			transport: "ssh",
			access: "control",
			url: `http://127.0.0.1:${server.port}/#access=${server.token}`,
		});
		expect(control.link.forward).toMatch(new RegExp(`^ssh -N -L ${server.port}:127\\.0\\.0\\.1:${server.port} \\S+$`));
		const view = await (await call(server.token, "POST", { transport: "ssh", access: "view" })).json();
		expect(view.link.url).toBe(`http://127.0.0.1:${server.port}/#access=${server.viewToken}`);
		const again = await (await call(server.token, "POST", { transport: "ssh", access: "view" })).json();
		expect(again.link).toEqual(view.link);
		const status = await (await call(server.token, "GET")).json();
		expect(Value.Check(RemoteStatusSchema, status)).toBe(true);
		expect(status.links.map((link: { access: string }) => link.access)).toEqual(["control", "view"]);
		expect(status.relay).toBeUndefined();
		expect((await call(server.token, "POST", { transport: "ssh", access: "root" })).status).toBe(400);
		expect((await call(server.token, "POST", { transport: "relay", access: "view" })).status).toBe(409);
	});

	it("stopping forgets the links and kills every view link by replacing the view token", async () => {
		const { server, call, origin } = await daemon();
		const oldView = server.viewToken;
		await call(server.token, "POST", { transport: "ssh", access: "view" });
		expect((await fetch(`${origin}/api/sessions`, { headers: { Authorization: `Bearer ${oldView}` } })).status).toBe(
			200,
		);
		expect((await call(server.token, "DELETE")).status).toBe(200);
		expect(server.viewToken).not.toBe(oldView);
		expect((await fetch(`${origin}/api/sessions`, { headers: { Authorization: `Bearer ${oldView}` } })).status).toBe(
			401,
		);
		expect(
			(await fetch(`${origin}/api/sessions`, { headers: { Authorization: `Bearer ${server.viewToken}` } })).status,
		).toBe(200);
		expect((await (await call(server.token, "GET")).json()).links).toEqual([]);
	});

	it("relays sealed requests and streams end to end, applies the room's access, and drops a bad frame", async () => {
		const relay = await startRelayFixture();
		cleanup.push(() => relay.close());
		const { server, call } = await daemon();
		const published = await (
			await call(server.token, "POST", { transport: "relay", access: "view", relayUrl: relay.url })
		).json();
		const link = new URL(published.link.url);
		expect(link.href.startsWith(relayPageUrl(relay.url).href)).toBe(true);
		expect(link.hash).toMatch(/^#k=[A-Za-z0-9_-]{43}$/);
		const key = decodeKey(link.hash.slice(3))!;
		const room = roomOf(key);
		await vi.waitFor(() => expect(relay.rooms.get(room)?.host).toBeDefined());
		await vi.waitFor(() => expect((server.remote.status().relay as { state: string }).state).toBe("connected"));

		const page = pageOver(await relay.peer(room), key);
		await vi.waitFor(() => expect(page.received[0]).toMatchObject({ kind: "hello", access: "view" }));
		page.send({ kind: "request", id: "r1", method: "GET", path: "/api/sessions" });
		await vi.waitFor(() => expect(page.received.find((m) => m.id === "r1")).toBeDefined());
		const sessions = page.received.find((m) => m.id === "r1")!;
		expect(sessions.status).toBe(200);
		expect(JSON.parse(sessions.body as string)).toEqual({ sessions: [] });
		// The room is view-only: the loopback server refuses the write, and the page never held a token to try otherwise.
		page.send({
			kind: "request",
			id: "r2",
			method: "POST",
			path: "/api/admin/drain",
		});
		await vi.waitFor(() => expect(page.received.find((m) => m.id === "r2")?.status).toBe(403));
		page.send({ kind: "stream.open", stream: "s1", path: `/r/${repoId(REPO_KEY)}/api/backlogs/live` });
		await vi.waitFor(() =>
			expect(
				page.received.some(
					(m) =>
						m.kind === "stream.message" &&
						(JSON.parse(String(m.data)) as { type: string; data?: { items?: Array<{ title: string }> } }).data
							?.items?.[0]?.title === "Daemon item",
				),
			).toBe(true),
		);
		expect(server.tabs.count).toBe(1);
		expect(server.remote.status().relay).toMatchObject({ state: "connected", peers: 1 });
		page.send({ kind: "stream.close", stream: "s1" });
		await vi.waitFor(() => expect(page.received.some((m) => m.kind === "stream.end" && m.stream === "s1")).toBe(true));
		await vi.waitFor(() => expect(server.tabs.count).toBe(0));

		// A frame not sealed for this room ends the peer; so does one that replays an old sequence.
		page.sendRaw("garbage");
		expect(await page.closed).toBe(1000);
		await vi.waitFor(() => expect(server.remote.status().relay).toMatchObject({ peers: 0 }));
		const replay = pageOver(await relay.peer(room), key);
		await vi.waitFor(() => expect(replay.received[0]).toMatchObject({ kind: "hello" }));
		replay.send({ kind: "request", id: "a", method: "GET", path: "/api/health" });
		await vi.waitFor(() => expect(replay.received.find((m) => m.id === "a")).toBeDefined());
		replay.sendRaw(seal(key, room, JSON.stringify({ seq: 0, kind: "request", id: "b", method: "GET", path: "/" })));
		expect(await replay.closed).toBe(1000);

		await call(server.token, "DELETE");
		await vi.waitFor(() => expect(relay.rooms.get(room)?.host).toBeUndefined());
	});

	it("accepts only ws(s) relay addresses and maps them to the page origin", () => {
		expect(validRelayUrl("wss://relay.example/octocode")).toBe("wss://relay.example/octocode");
		expect(validRelayUrl("ws://127.0.0.1:8080")).toBe("ws://127.0.0.1:8080/");
		expect(validRelayUrl("https://relay.example")).toBeUndefined();
		expect(validRelayUrl("wss://user:pw@relay.example")).toBeUndefined();
		expect(validRelayUrl("wss://relay.example/#frag")).toBeUndefined();
		expect(validRelayUrl("nonsense")).toBeUndefined();
		expect(relayPageUrl("wss://relay.example/octocode?x=1").href).toBe("https://relay.example/octocode/");
		expect(relayPageUrl("ws://127.0.0.1:8080").href).toBe("http://127.0.0.1:8080/");
	});
});
