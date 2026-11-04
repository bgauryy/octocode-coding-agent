import { workspaces } from "../../../db/src/api.ts";
import { registeredWorkspace } from "../../src/config/workspace-database.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { DaemonHealthSchema, DaemonStatusSchema } from "@octocodeai/octocode-contracts/daemon";
import { Value } from "typebox/value";
import { mermaidScript } from "@octocodeai/octocode-webview";
import { sharedAgentDb } from "../../src/config/database.ts";
import { startAttachServer, type AttachEndpoint } from "../../src/octocode/web-daemon/attach-server.ts";
import { daemonPage } from "../../src/octocode/web-daemon/build.ts";
import { LaunchCodes } from "../../src/octocode/web-daemon/launch-code.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { fakeSession, frame, isolatedEnv } from "./web-daemon-fixture.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

const REPO_KEY = "ce04658b-7c62-406f-b82b-f2dbd3e8536f";

async function daemon() {
	const { env } = isolatedEnv();
	let drained = 0;
	const server: DaemonServer = await startDaemonServer({
		env,
		onActivity: () => {},
		config: async () => ({ protocolVersion: 1, providers: [] }),
		onDrain: () => void drained++,
	});
	cleanup.push(() => server.close());
	const origin = `http://127.0.0.1:${server.port}`;
	const get = (path: string, init: RequestInit = {}) => fetch(origin + path, init);
	const authed = (path: string, init: RequestInit = {}) =>
		get(path, { ...init, headers: { Authorization: `Bearer ${server.token}`, ...(init.headers as object) } });
	return { env, server, origin, get, authed, drained: () => drained };
}

/** A raw request with any Host header: fetch refuses to forge one. */
function rawRequest(
	port: number,
	path: string,
	headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const request = http.request({ host: "127.0.0.1", port, path, headers }, (response) => {
			let body = "";
			response.on("data", (chunk) => (body += chunk));
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
		});
		request.on("error", reject);
		request.end();
	});
}

function seedBacklog(env: NodeJS.ProcessEnv) {
	workspaces.register(sharedAgentDb(env).db, { id: REPO_KEY, name: "demo", root: "/work/demo", binding: "mock" });
	const store = fixtureBacklog(() => sharedAgentDb(env), REPO_KEY);
	store.add({ title: "Daemon item", goal: "Seen in the daemon", createdBy: "tester" }, { id: "tester" });
}

describe("daemon HTTP rules", () => {
	it("serves the page without a token and with a script-hash CSP, and nothing else without one", async () => {
		const { get, server } = await daemon();
		const page = await get("/");
		expect(page.status).toBe(200);
		const csp = page.headers.get("content-security-policy") ?? "";
		expect(csp).toContain(`script-src '${daemonPage().scriptHash}'`);
		expect(csp).toMatch(/default-src 'none'/);
		expect(csp).toMatch(/frame-ancestors 'none'/);
		expect(csp).toMatch(/connect-src 'self'/);
		expect(csp.match(/script-src[^;]*/)![0]).not.toContain("unsafe-inline");
		expect(page.headers.get("referrer-policy")).toBe("no-referrer");
		const html = await page.text();
		expect(html).not.toContain(server.token);
		// The header's hash is the hash of the one script the browser will run (text between the tags, as a browser hashes it).
		const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
		expect(csp).toContain(`'sha256-${createHash("sha256").update(script).digest("base64")}'`);
		expect(html).toContain('data-daemon="true"');
		// Attachment previews are page-made blob: URLs; the docs view runs the bundled Mermaid text as an inline script.
		expect(csp).toMatch(/(^|; )img-src data: blob:(;|$)/);
		expect(csp).toMatch(/(^|; )media-src blob:(;|$)/);
		const mermaid = await mermaidScript();
		expect(csp.match(/script-src[^;]*/)![0]).toContain(
			`'sha256-${createHash("sha256").update(mermaid).digest("base64")}'`,
		);
		for (const route of ["/api/sessions", "/api/repos", "/api/config", "/s/x/api/backlogs", "/r/x/api/backlogs"]) {
			const refused = await get(route);
			expect(refused.status, route).toBe(401);
		}
		expect((await get("/api/admin/drain", { method: "POST" })).status).toBe(401);
	});

	it("answers health with compatibility only unless the bearer token is presented", async () => {
		const { get, authed, server } = await daemon();
		const anonymous = await (await get("/api/health")).json();
		expect(Value.Check(DaemonHealthSchema, anonymous)).toBe(true);
		expect(JSON.stringify(anonymous)).not.toContain(server.nonce);
		const status = await (await authed("/api/health")).json();
		expect(Value.Check(DaemonStatusSchema, status)).toBe(true);
		expect(status).toMatchObject({ nonce: server.nonce, pid: process.pid, draining: false });
		const wrong = await get("/api/health", { headers: { Authorization: "Bearer nope" } });
		expect(Value.Check(DaemonHealthSchema, await wrong.json())).toBe(true);
	});

	it("takes the token only from the Authorization header, never from the URL", async () => {
		const { get, server } = await daemon();
		expect((await get(`/api/sessions?access=${server.token}`)).status).toBe(401);
		expect(
			(await get(`/api/sessions?token=${server.token}`, { headers: { Authorization: "Bearer wrong" } })).status,
		).toBe(401);
		expect((await get(`/api/sessions`, { headers: { Authorization: `Basic ${server.token}` } })).status).toBe(401);
	});

	it("opens the page once from a code the launch token alone can issue, with the token only in the redirect's fragment", async () => {
		const { get, authed, server, origin } = await daemon();
		expect((await get("/api/admin/launch-code", { method: "POST" })).status).toBe(401);
		expect(
			(
				await get("/api/admin/launch-code", {
					method: "POST",
					headers: { Authorization: `Bearer ${server.remoteToken}` },
				})
			).status,
		).toBe(403);
		const { code } = (await (await authed("/api/admin/launch-code", { method: "POST" })).json()) as { code: string };
		expect(code).not.toContain(server.token);
		const door = await fetch(`${origin}/open/${code}?s=sess-1&view=activity`, { redirect: "manual" });
		expect(door.status).toBe(303);
		expect(door.headers.get("cache-control")).toBe("no-store");
		const target = new URL(door.headers.get("location")!, origin);
		expect(target.pathname + target.search).toBe("/?s=sess-1");
		expect(new URLSearchParams(target.hash.slice(1)).get("access")).toBe(server.token);
		expect(new URLSearchParams(target.hash.slice(1)).get("view")).toBe("activity");
		// Used once, it is gone; a made-up one never worked.
		expect((await fetch(`${origin}/open/${code}`, { redirect: "manual" })).status).toBe(401);
		expect((await fetch(`${origin}/open/nope`, { redirect: "manual" })).status).toBe(401);
	});

	it("ignores a session or view in the door's query that a page should not be given", async () => {
		const { authed, origin } = await daemon();
		const { code } = (await (await authed("/api/admin/launch-code", { method: "POST" })).json()) as { code: string };
		const door = await fetch(
			`${origin}/open/${code}?s=${encodeURIComponent('"><x')}&view=${encodeURIComponent("a&b")}`,
			{
				redirect: "manual",
			},
		);
		const target = new URL(door.headers.get("location")!, origin);
		expect(target.search).toBe("");
		expect(new URLSearchParams(target.hash.slice(1)).get("view")).toBeNull();
	});

	it("ends a code nobody used", () => {
		let now = 1_000;
		const codes = new LaunchCodes(() => now);
		const code = codes.issue();
		now += 5 * 60_000;
		expect(codes.take(code)).toBe(false);
	});

	it("refuses another Host or Origin with 403, on every route including the page and health", async () => {
		const { server, authed, origin } = await daemon();
		const bearer = { authorization: `Bearer ${server.token}` };
		for (const path of ["/", "/api/health", "/api/sessions"]) {
			expect((await rawRequest(server.port, path, { host: "evil.example", ...bearer })).status, path).toBe(403);
			expect((await rawRequest(server.port, path, { host: `localhost:${server.port}`, ...bearer })).status, path).toBe(
				403,
			);
			expect(
				(
					await rawRequest(server.port, path, {
						host: `127.0.0.1:${server.port}`,
						origin: "https://evil.example",
						...bearer,
					})
				).status,
				path,
			).toBe(403);
		}
		expect((await authed("/api/sessions", { headers: { Origin: origin } })).status).toBe(200);
	});

	it("sends no CORS headers and does not answer a preflight", async () => {
		const { get, authed, server } = await daemon();
		const preflight = await get("/api/sessions", {
			method: "OPTIONS",
			headers: {
				Origin: "https://evil.example",
				"Access-Control-Request-Method": "GET",
				"Access-Control-Request-Headers": "authorization",
			},
		});
		expect(preflight.status).toBe(403);
		expect([...preflight.headers.keys()].filter((name) => name.startsWith("access-control"))).toEqual([]);
		const ok = await authed("/api/sessions");
		expect(ok.headers.get("access-control-allow-origin")).toBeNull();
		expect(ok.headers.get("set-cookie")).toBeNull();
		const same = await get("/api/sessions", {
			method: "OPTIONS",
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(same.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("serves the configuration through the injected builder behind the token, and drains on request", async () => {
		const { authed, drained } = await daemon();
		expect(await (await authed("/api/config")).json()).toEqual({
			protocolVersion: 1,
			providers: [],
			writable: true,
		});
		expect((await authed("/api/config?repoId=unknown")).status).toBe(404);
		expect((await authed("/api/admin/drain", { method: "POST" })).status).toBe(200);
		expect(drained()).toBe(1);
	});

	it("names no path in any route: unknown scopes and traversal are 404", async () => {
		const { authed } = await daemon();
		for (const route of [
			"/s/..%2F..%2Fetc/api/backlogs",
			"/r/..%2Fetc/api/reports",
			"/r/nope/api/reports",
			"/s/nope/api/application",
			"/etc/passwd",
		]) {
			expect((await authed(route)).status, route).toBe(404);
		}
	});
});

describe("daemon with attached sessions and repositories", () => {
	async function attached() {
		const ctx = await daemon();
		seedBacklog(ctx.env);
		const session = fakeSession("sess-1");
		const endpoint: AttachEndpoint = await startAttachServer(
			{
				sessionId: "sess-1",
				cwd: "/work/demo",
				repo: { key: REPO_KEY, name: "demo", root: "/work/demo" },
				workspace: session.workspace,
			},
			ctx.env,
		);
		cleanup.push(() => endpoint.close());
		await ctx.server.registry.refresh();
		await new Promise((resolve) => setTimeout(resolve, 200));
		await ctx.server.registry.refresh();
		await (async () => {
			for (let tries = 0; tries < 40 && ctx.server.registry.attached === 0; tries++)
				await new Promise((resolve) => setTimeout(resolve, 50));
		})();
		return { ...ctx, session, endpoint };
	}

	it("lists live sessions from attach records and repositories from the agent database", async () => {
		const { authed, server } = await attached();
		expect(server.registry.attached).toBe(1);
		const sessions = await (await authed("/api/sessions")).json();
		expect(sessions.sessions).toEqual([
			expect.objectContaining({ id: "sess-1", repoName: "demo", repoId: REPO_KEY, attached: true }),
		]);
		const repos = await (await authed("/api/repos")).json();
		expect(repos.repos).toEqual([expect.objectContaining({ id: REPO_KEY, name: "demo", sessions: 1 })]);
	});

	it("proxies session commands through the attach endpoint and keeps the board read-only", async () => {
		const { authed, session } = await attached();
		const base = "/s/sess-1";
		const prompt = { id: "p1", sessionId: "sess-1", action: "prompt", text: "hello" };
		const sent = await authed(`${base}/api/application`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(prompt),
		});
		expect(await sent.json()).toMatchObject({ receipt: { id: "p1", status: "accepted" } });
		expect(session.executed).toHaveLength(1);
		const other = await authed(`${base}/api/application`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...prompt, sessionId: "other" }),
		});
		expect(other.status).toBe(409);
		expect((await authed(`${base}/api/workspace`)).status).toBe(200);
		const board = await (await authed(`${base}/api/backlogs`)).json();
		expect(board.items.map((item: { title: string }) => item.title)).toEqual(["Daemon item"]);
		const write = await authed(`${base}/api/backlogs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ op: "add", title: "nope" }),
		});
		expect(write.status).toBe(405);
		const task = await authed(`${base}/api/backlogs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command: "task.add", goal: "nope" }),
		});
		expect(task.status).toBe(405);
		const history = await authed(`${base}/api/application/history?sessionId=sess-1&limit=5`);
		expect(history.status).toBe(200);
		expect((await authed(`${base}/api/application/history?sessionId=wrong`)).status).toBe(409);
	});

	it("serves a repository's board with no session and refuses agent controls there", async () => {
		const { authed } = await attached();
		const base = `/r/${REPO_KEY}`;
		const board = await (await authed(`${base}/api/backlogs`)).json();
		expect(board.items).toHaveLength(1);
		expect((await authed(`${base}/api/workspace`)).status).toBe(503);
		expect((await authed(`${base}/api/application`, { method: "POST" })).status).toBe(503);
		expect((await authed(`${base}/api/backlogs`, { method: "POST" })).status).toBe(405);
		expect(await (await authed(`${base}/api/reports`)).json()).toEqual({ reports: [] });
	});

	it("serves saved reports of an indexed repository read-only, and only files its index lists", async () => {
		const ctx = await daemon();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-daemon-reports-"));
		cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
		const folder = path.join(root, ".octocode", "octocode-rfc-generator", "2026-01-01-demo");
		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, "RFC.md"), "---\nstatus: Proposed\n---\n# Demo RFC\n");
		fs.writeFileSync(path.join(root, "secret.md"), "# not a report\n");
		const key = registeredWorkspace(root, sharedAgentDb(ctx.env)).id;
		const base = `/r/${key}`;
		const index = await (await ctx.authed(`${base}/api/reports`)).json();
		expect(index.reports).toEqual([expect.objectContaining({ id: "2026-01-01-demo", kind: "rfc", title: "Demo RFC" })]);
		const file = await ctx.authed(`${base}/api/reports/file?id=2026-01-01-demo&kind=rfc&name=RFC.md`);
		expect(await file.json()).toMatchObject({ markdown: expect.stringContaining("# Demo RFC") });
		for (const name of ["../../../secret.md", "..%2F..%2F..%2Fsecret.md", "secret.md"])
			expect((await ctx.authed(`${base}/api/reports/file?id=2026-01-01-demo&kind=rfc&name=${name}`)).status, name).toBe(
				404,
			);
		expect((await ctx.authed(`${base}/api/reports`, { method: "POST" })).status).toBe(405);
		// The history stays addressable when a different checkout replaces the one recorded at this path.
		fs.rmSync(path.join(root, ".octocode"), { recursive: true });
		const replacement = registeredWorkspace(root, sharedAgentDb(ctx.env));
		expect(replacement.id).not.toBe(key);
		expect(await (await ctx.authed(`${base}/api/reports`)).json()).toEqual({ reports: [] });
		expect((await ctx.authed(`/r/${replacement.id}/api/reports`)).status).toBe(200);
	});

	it("opens a tab socket only for the exact origin and host, then needs the token hello", async () => {
		const { server, origin } = await attached();
		const url = `ws://127.0.0.1:${server.port}/s/sess-1/api/backlogs/live`;
		const refused = (headers: Record<string, string>) =>
			new Promise<number>((resolve) => {
				const socket = new WebSocket(url, { headers });
				socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
				socket.on("open", () => resolve(101));
				socket.on("error", () => undefined);
			});
		expect(await refused({ Origin: "https://evil.example" })).toBe(403);
		expect(await refused({})).toBe(403);
		expect(await refused({ Origin: origin, Host: "evil.example" })).toBe(403);
		const badToken = new WebSocket(url, { headers: { Origin: origin } });
		const closed = await new Promise<number>((resolve) => {
			badToken.on("open", () => badToken.send(JSON.stringify({ token: "wrong", protocolVersion: 1 })));
			badToken.on("close", (code) => resolve(code));
		});
		expect(closed).toBe(1008);
	});

	it("streams the board, workspace and application frames to an authenticated tab", async () => {
		const { server, origin, session } = await attached();
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/s/sess-1/api/backlogs/live`, {
			headers: { Origin: origin },
		});
		cleanup.push(() => socket.terminate());
		const packets: Array<{ type: string; data: any }> = [];
		socket.on("message", (data) => packets.push(JSON.parse(String(data))));
		await new Promise<void>((resolve) => socket.on("open", () => resolve()));
		socket.send(JSON.stringify({ token: server.token, protocolVersion: 1 }));
		await new Promise<void>((resolve) => {
			const timer = setInterval(() => {
				if (
					packets.some((packet) => packet.type === "snapshot") &&
					packets.some((packet) => packet.type === "workspace") &&
					session.connects.length
				) {
					clearInterval(timer);
					resolve();
				}
			}, 25);
		});
		expect(packets.find((packet) => packet.type === "snapshot")!.data.items).toHaveLength(1);
		session.push(frame("sess-1", 1));
		await new Promise<void>((resolve) => {
			const timer = setInterval(() => {
				if (packets.some((packet) => packet.type === "application")) {
					clearInterval(timer);
					resolve();
				}
			}, 25);
		});
		expect(server.tabs.count).toBe(1);
		socket.close();
		await new Promise<void>((resolve) => {
			const timer = setInterval(() => {
				if (server.tabs.count === 0) {
					clearInterval(timer);
					resolve();
				}
			}, 25);
		});
	});

	it("sends the board again only after the database changed, and announces a drain to open tabs", async () => {
		const { server, origin, env } = await attached();
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/r/${REPO_KEY}/api/backlogs/live`, {
			headers: { Origin: origin },
		});
		cleanup.push(() => socket.terminate());
		const packets: Array<{ type: string; data: any }> = [];
		socket.on("message", (data) => packets.push(JSON.parse(String(data))));
		await new Promise<void>((resolve) => socket.on("open", () => resolve()));
		socket.send(JSON.stringify({ token: server.token, protocolVersion: 1 }));
		await vi.waitFor(() => expect(packets.filter((packet) => packet.type === "snapshot")).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 1600));
		expect(packets.filter((packet) => packet.type === "snapshot")).toHaveLength(1);
		fixtureBacklog(() => sharedAgentDb(env), REPO_KEY).add(
			{ title: "Second", goal: "Seen later", createdBy: "t" },
			{ id: "t" },
		);
		await vi.waitFor(() => expect(packets.filter((packet) => packet.type === "snapshot")).toHaveLength(2));
		expect(packets.filter((packet) => packet.type === "snapshot")[1].data.items).toHaveLength(2);
		server.draining = true;
		await vi.waitFor(() =>
			expect(packets.some((packet) => packet.type === "daemon" && packet.data.draining)).toBe(true),
		);
		const late = await new Promise<number>((resolve) => {
			const next = new WebSocket(`ws://127.0.0.1:${server.port}/r/${REPO_KEY}/api/backlogs/live`, {
				headers: { Origin: origin },
			});
			next.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
			next.on("open", () => resolve(101));
			next.on("error", () => undefined);
		});
		expect(late).toBe(503);
	});

	it("gives a view token every read and the live stream without capabilities, and never a write", async () => {
		const { server, origin, session, get } = await attached();
		const viewed = (path: string, init: RequestInit = {}) =>
			get(path, { ...init, headers: { Authorization: `Bearer ${server.viewToken}`, ...(init.headers as object) } });
		expect(server.viewToken).not.toBe(server.token);
		expect((await viewed("/api/health")).status).toBe(200);
		expect((await (await viewed("/api/health")).json()).nonce).toBe(server.nonce);
		expect((await (await viewed("/api/sessions")).json()).sessions).toHaveLength(1);
		expect((await viewed("/s/sess-1/api/workspace")).status).toBe(200);
		expect((await viewed("/s/sess-1/api/application/history?sessionId=sess-1&limit=5")).status).toBe(200);
		const command = { id: "v1", sessionId: "sess-1", action: "prompt", text: "hello" };
		const sent = await viewed("/s/sess-1/api/application", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(command),
		});
		expect(sent.status).toBe(403);
		expect((await sent.json()).error).toMatch(/view-only/);
		expect(session.executed).toHaveLength(0);
		const taskCommand = await viewed("/s/sess-1/api/backlogs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command: "task.add", goal: "nope" }),
		});
		expect(taskCommand.status).toBe(403);
		expect((await viewed("/api/admin/drain", { method: "POST" })).status).toBe(403);
		expect((await viewed("/api/admin/remote", { method: "POST" })).status).toBe(403);
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/s/sess-1/api/backlogs/live`, {
			headers: { Origin: origin },
		});
		cleanup.push(() => socket.terminate());
		const packets: Array<{ type: string; data: any }> = [];
		socket.on("message", (data) => packets.push(JSON.parse(String(data))));
		await new Promise<void>((resolve) => socket.on("open", () => resolve()));
		socket.send(JSON.stringify({ token: server.viewToken, protocolVersion: 1 }));
		// The registry follows the session's run state on a stream of its own; the tab's stream is the second one.
		await vi.waitFor(() => expect(session.connects.length).toBe(2));
		session.push({
			protocolVersion: 1,
			cursor: { sessionId: "sess-1", epoch: "e", sequence: 1 },
			at: 1,
			type: "snapshot",
			snapshot: {
				sessionId: "sess-1",
				messages: [],
				streaming: true,
				steering: [],
				followUp: [],
				receipts: [],
				capabilities: ["prompt", "steer", "followUp", "abort", "answer"],
			},
		});
		await vi.waitFor(() => expect(packets.some((packet) => packet.type === "application")).toBe(true));
		expect(packets.find((packet) => packet.type === "application")!.data.snapshot.capabilities).toEqual([]);
		expect(server.tabs.count).toBe(1);
	});

	it("tells a detached session's tabs to reconnect: a closed session leaves the list", async () => {
		const { server, authed, endpoint } = await attached();
		await endpoint.close();
		for (let tries = 0; tries < 60 && server.registry.attached > 0; tries++)
			await new Promise((resolve) => setTimeout(resolve, 50));
		expect(server.registry.attached).toBe(0);
		expect((await (await authed("/api/sessions")).json()).sessions).toEqual([]);
		expect((await authed("/s/sess-1/api/workspace")).status).toBe(404);
		// The board and repositories stay available with no session attached.
		expect((await (await authed(`/r/${REPO_KEY}/api/backlogs`)).json()).items).toHaveLength(1);
	});
});
