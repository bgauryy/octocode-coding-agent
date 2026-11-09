import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { workspaces } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { startAttachServer } from "../../src/octocode/web-daemon/attach-server.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";
import { fakeSession, isolatedEnv } from "./web-daemon-fixture.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

const REPO_KEY = "ce04658b-7c62-406f-b82b-f2dbd3e8536f";
const JSON_HEADERS = { "content-type": "application/json" };

interface BoardItem {
	ref: string;
	title: string;
	state: string;
	version: number;
}

async function daemon() {
	const { env } = isolatedEnv();
	const server: DaemonServer = await startDaemonServer({
		env,
		onActivity: () => {},
		config: async () => ({ protocolVersion: 1, providers: [] }),
		onDrain: () => {},
	});
	cleanup.push(() => server.close());
	workspaces.register(sharedAgentDb(env).db, { id: REPO_KEY, name: "demo", root: "/work/demo", binding: "mock" });
	fixtureBacklog(() => sharedAgentDb(env), REPO_KEY).add(
		{ title: "Daemon item", goal: "Written through the daemon", createdBy: "tester" },
		{ id: "tester" },
	);
	const origin = `http://127.0.0.1:${server.port}`;
	const call = (token: string | undefined, path: string, body?: unknown, headers: Record<string, string> = {}) =>
		fetch(origin + path, {
			method: body === undefined ? "GET" : "POST",
			headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...JSON_HEADERS, ...headers },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const board = async (path = `/r/${REPO_KEY}/api/backlogs`) =>
		((await (await call(server.token, path)).json()) as { items: BoardItem[] }).items;
	return { env, server, call, board };
}

/** A raw POST with a chosen Origin header (a script in another page sends one; fetch here would not let a test forge it). */
function rawPost(port: number, path: string, token: string, origin: string, body: unknown): Promise<number> {
	return new Promise((resolve, reject) => {
		const request = http.request(
			{
				host: "127.0.0.1",
				port,
				path,
				method: "POST",
				headers: { ...JSON_HEADERS, authorization: `Bearer ${token}`, origin },
			},
			(response) => {
				response.resume();
				response.on("end", () => resolve(response.statusCode ?? 0));
			},
		);
		request.on("error", reject);
		request.end(JSON.stringify(body));
	});
}

describe("daemon board writes", () => {
	it("applies a typed command and an add/comment from the launch token, as the user", async () => {
		const { server, call, board } = await daemon();
		const path = `/r/${REPO_KEY}/api/backlogs`;
		const [first] = await board();
		const moved = await call(server.token, path, {
			command: "item.state",
			id: first.ref,
			state: "todo",
			version: first.version,
		});
		expect(moved.status).toBe(200);
		expect(await moved.json()).toMatchObject({ item: { ref: first.ref, state: "todo" } });
		expect((await board())[0].state).toBe("todo");

		const added = await call(server.token, path, { op: "add", title: "Added in the daemon", why: "A test" });
		expect(added.status).toBe(200);
		expect((await board()).map((item) => item.title)).toContain("Added in the daemon");
		const [current] = await board();
		const commented = await call(server.token, path, {
			op: "comment",
			id: current.ref,
			version: current.version,
			note: "Seen in the daemon",
		});
		expect(commented.status).toBe(200);
	});

	it("refuses a write without a token, with a wrong token or a view link, and changes nothing", async () => {
		const { server, call, board } = await daemon();
		const path = `/r/${REPO_KEY}/api/backlogs`;
		const before = await board();
		const add = { op: "add", title: "Must not appear", why: "A test" };
		expect((await call(undefined, path, add)).status).toBe(401);
		expect((await call("0".repeat(64), path, add)).status).toBe(401);
		expect((await call(server.viewToken, path, add)).status).toBe(403);
		expect(await board()).toEqual(before);
	});

	it("tells the page which tokens may write, and nothing to a stranger", async () => {
		const { server, call } = await daemon();
		const writable = async (token: string) =>
			(await (await call(token, "/api/access")).json()) as { writable: boolean };
		expect(await writable(server.token)).toEqual({ writable: true });
		expect(await writable(server.remoteToken)).toEqual({ writable: true });
		expect(await writable(server.viewToken)).toEqual({ writable: false });
		expect((await call(undefined, "/api/access")).status).toBe(401);
	});

	it("refuses a write from a foreign origin or Host, even with the launch token", async () => {
		const { server, board } = await daemon();
		const path = `/r/${REPO_KEY}/api/backlogs`;
		const before = await board();
		const add = { op: "add", title: "Must not appear", why: "A test" };
		expect(await rawPost(server.port, path, server.token, "https://evil.example", add)).toBe(403);
		expect(await rawPost(server.port, path, server.token, "http://127.0.0.1:1", add)).toBe(403);
		expect(await board()).toEqual(before);
	});

	it("lets a published control link write", async () => {
		const { server, call, board } = await daemon();
		const path = `/r/${REPO_KEY}/api/backlogs`;
		expect(
			(await call(server.remoteToken, path, { op: "add", title: "From a control link", why: "A test" })).status,
		).toBe(200);
		expect((await board()).map((item) => item.title)).toContain("From a control link");
	});

	it("answers bad bodies and stale versions as the session server does", async () => {
		const { server, call, board } = await daemon();
		const path = `/r/${REPO_KEY}/api/backlogs`;
		expect((await call(server.token, path, { command: "nope" })).status).toBe(400);
		expect((await call(server.token, path, { op: "add", title: "x", extra: 1 })).status).toBe(400);
		expect((await call(server.token, path, { op: "update", state: "todo" })).status).toBe(400);
		// A repository scope has no session to own a task: it must name an item or a session.
		expect((await call(server.token, path, { command: "task.add", goal: "orphan" })).status).toBe(400);
		const [first] = await board();
		const stale = await call(server.token, path, {
			command: "item.state",
			id: first.ref,
			state: "todo",
			version: first.version + 5,
		});
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ error: expect.any(String), current: { ref: first.ref } });
		expect((await call(server.token, path, JSON.stringify("x"))).status).toBe(400);
		const notJson = await fetch(`http://127.0.0.1:${server.port}${path}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${server.token}` },
			body: "{}",
		});
		expect(notJson.status).toBe(400);
	});

	it("owns a task added through an attached session's scope by that session", async () => {
		const { env, server, call, board } = await daemon();
		const session = fakeSession("sess-1");
		const endpoint = await startAttachServer(
			{
				sessionId: "sess-1",
				cwd: "/work/demo",
				repo: { key: REPO_KEY, name: "demo", root: "/work/demo" },
				workspace: session.workspace,
			},
			env,
		);
		cleanup.push(() => endpoint.close());
		for (let tries = 0; tries < 40 && server.registry.attached === 0; tries++) {
			await server.registry.refresh();
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(server.registry.attached).toBe(1);
		const path = "/s/sess-1/api/backlogs";
		const added = await call(server.token, path, { command: "task.add", goal: "Step in the session" });
		expect(added.status).toBe(200);
		expect(await added.json()).toMatchObject({
			task: { goal: "Step in the session", owner: { kind: "session", id: "sess-1" } },
		});
		expect((await call(undefined, path, { op: "add", title: "No token", why: "A test" })).status).toBe(401);
		expect((await board(path)).map((item) => item.title)).toEqual(["Daemon item"]);
	});
});
