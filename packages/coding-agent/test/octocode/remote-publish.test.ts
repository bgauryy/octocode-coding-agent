import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { RemoteStatusSchema } from "@octocodeai/octocode-contracts/daemon";
import { relayPageUrl, validRelayUrl } from "../../src/octocode/web-daemon/remote/publisher.ts";
import { repoId } from "../../src/octocode/web-daemon/sessions.ts";
import { daemon, pageOver, publishRelay, REPO_KEY } from "./remote-page-fixture.ts";

const sessions = (origin: string, token: string) =>
	fetch(`${origin}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } });

describe("remote publication", () => {
	it("issues ssh links with the remote token, never the launch token, and only to the launch token", async () => {
		const { server, call } = await daemon();
		expect(server.remoteToken).not.toBe(server.token);
		expect(server.remoteToken).not.toBe(server.viewToken);
		expect((await call(server.viewToken, "GET")).status).toBe(403);
		expect((await call(server.viewToken, "POST", { transport: "ssh", access: "view" })).status).toBe(403);
		expect((await call(server.remoteToken, "GET")).status).toBe(403);
		expect((await call(server.remoteToken, "POST", { transport: "ssh", access: "control" })).status).toBe(403);
		const control = await (await call(server.token, "POST", { transport: "ssh", access: "control" })).json();
		expect(control.link).toMatchObject({
			transport: "ssh",
			access: "control",
			url: `http://127.0.0.1:${server.port}/#access=${server.remoteToken}`,
		});
		expect(control.link.url).not.toContain(server.token);
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

	it("lists links by fingerprint only: no token, key or URL in the status", async () => {
		const { server, call } = await daemon();
		await call(server.token, "POST", { transport: "ssh", access: "control" });
		await call(server.token, "POST", { transport: "ssh", access: "view" });
		const raw = await (await call(server.token, "GET")).text();
		for (const secret of [server.token, server.remoteToken, server.viewToken]) expect(raw).not.toContain(secret);
		expect(raw).not.toContain("#access");
		const status = JSON.parse(raw) as { links: Array<{ fingerprint: string; url?: string }> };
		expect(status.links.map((link) => link.fingerprint)).toEqual([
			expect.stringMatching(/^[0-9a-f]{8}$/),
			expect.stringMatching(/^[0-9a-f]{8}$/),
		]);
		expect(status.links[0].fingerprint).not.toBe(status.links[1].fingerprint);
		expect(status.links.every((link) => link.url === undefined)).toBe(true);
		const relay = await publishRelay("control");
		const relayRaw = await (await relay.call(relay.server.token, "GET")).text();
		expect(relayRaw).not.toContain(relay.link.hash.slice(3));
		expect(relayRaw).not.toContain(relay.room);
	});

	it("a control link works like the page but never reaches admin routes; stopping kills every link", async () => {
		const { server, call, origin } = await daemon();
		const control = server.remoteToken;
		const oldView = server.viewToken;
		await call(server.token, "POST", { transport: "ssh", access: "control" });
		await call(server.token, "POST", { transport: "ssh", access: "view" });
		expect((await sessions(origin, control)).status).toBe(200);
		expect((await sessions(origin, oldView)).status).toBe(200);
		// A session command: the control link passes the access checks (the unknown session is a 404), a view link is refused.
		const command = (token: string) =>
			fetch(`${origin}/s/missing/api/application`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: "{}",
			});
		expect((await command(control)).status).toBe(404);
		expect((await command(oldView)).status).toBe(403);
		expect((await call(control, "POST", undefined, "/api/admin/drain")).status).toBe(403);
		expect((await call(control, "GET")).status).toBe(403);
		expect((await call(control, "DELETE")).status).toBe(403);
		expect((await call(control, "POST", { transport: "ssh", access: "control" })).status).toBe(403);
		expect((await call(control, "GET", undefined, "/api/admin/anything")).status).toBe(403);

		expect((await call(server.token, "DELETE")).status).toBe(200);
		expect(server.viewToken).not.toBe(oldView);
		expect(server.remoteToken).not.toBe(control);
		expect((await sessions(origin, control)).status).toBe(401);
		expect((await sessions(origin, oldView)).status).toBe(401);
		expect((await call(control, "GET")).status).toBe(401);
		// The launch token and the new tokens still work.
		expect((await sessions(origin, server.token)).status).toBe(200);
		expect((await sessions(origin, server.viewToken)).status).toBe(200);
		expect((await sessions(origin, server.remoteToken)).status).toBe(200);
		expect((await (await call(server.token, "GET")).json()).links).toEqual([]);
	});

	it("relays sealed requests and streams end to end, applies the room's access, and drops a bad frame", async () => {
		const { server, call, relay, key, room } = await publishRelay("view");
		const page = pageOver(await relay.peer(room), key);
		await vi.waitFor(() => expect(page.received[0]).toMatchObject({ kind: "hello", access: "view" }));
		await page.send({ kind: "request", id: "r1", method: "GET", path: "/api/sessions" });
		await vi.waitFor(() => expect(page.received.find((m) => m.id === "r1")).toBeDefined());
		const listed = page.received.find((m) => m.id === "r1")!;
		expect(listed.status).toBe(200);
		expect(JSON.parse(listed.body as string)).toEqual({ sessions: [] });
		// The room is view-only: the loopback server refuses the write, and the page never held a token to try otherwise.
		await page.send({ kind: "request", id: "r2", method: "POST", path: "/api/admin/drain" });
		await vi.waitFor(() => expect(page.received.find((m) => m.id === "r2")?.status).toBe(403));
		await page.send({ kind: "stream.open", stream: "s1", path: `/r/${repoId(REPO_KEY)}/api/backlogs/live` });
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
		await page.send({ kind: "stream.close", stream: "s1" });
		await vi.waitFor(() => expect(page.received.some((m) => m.kind === "stream.end" && m.stream === "s1")).toBe(true));
		await vi.waitFor(() => expect(server.tabs.count).toBe(0));

		// A frame in no known format ends the peer; so does one that replays an old sequence on the same peer.
		page.sendRaw("garbage");
		expect(await page.closed).toBe(1000);
		await vi.waitFor(() => expect(server.remote.status().relay).toMatchObject({ peers: 0 }));
		const same = pageOver(await relay.peer(room), key);
		await vi.waitFor(() => expect(same.received[0]).toMatchObject({ kind: "hello" }));
		await same.send({ kind: "request", id: "a", method: "GET", path: "/api/health" });
		await vi.waitFor(() => expect(same.received.find((m) => m.id === "a")).toBeDefined());
		same.sendRaw(same.sent[0]);
		expect(await same.closed).toBe(1000);

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
