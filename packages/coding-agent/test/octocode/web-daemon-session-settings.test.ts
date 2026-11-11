import fs from "node:fs";
import path from "node:path";
import type { AttachToolStates } from "@octocodeai/octocode-contracts/daemon";
import type { ToolExposureList } from "@octocodeai/octocode-contracts/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaces } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { startAttachServer } from "../../src/octocode/web-daemon/attach-server.ts";
import { createConfigRoutes } from "../../src/octocode/web-daemon/config-factory.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { sessionToolStates } from "../../src/octocode/web-daemon/session-tools.ts";
import { startWorkspaceWeb } from "../../src/octocode/workspace/server.ts";
import { fakeSession, isolatedEnv } from "./web-daemon-fixture.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

const REPO_KEY = "0b6c5f0e-63a8-4a34-9b8c-4f3e7d0f6a11";
const JSON_HEADERS = { "content-type": "application/json" };

/** What the running session declares: `web` deferred, `archive` direct, and one MCP server it registered itself. */
const DECLARED: AttachToolStates = sessionToolStates(
	{
		names: ["read", "web", "archive"],
		declared: new Map([
			["web", true],
			["archive", false],
		]),
	},
	[{ server: "ext", connected: true, saved: false, tools: [{ name: "run", state: "deferred", decidedBy: "recent" }] }],
);

/** A daemon with the real settings routes and one attached session (`sess-1`) of the `demo` repository. */
async function setup(options: { tools?: boolean } = {}) {
	const { env, dir } = isolatedEnv();
	// The settings routes read the agent directory from the process, as the daemon does.
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", env.OCTOCODE_CODING_AGENT_DIR);
	const root = path.join(dir, "demo");
	fs.mkdirSync(root, { recursive: true });
	const { routes, signIns } = createConfigRoutes({ env, actor: () => "web:test" });
	const server: DaemonServer = await startDaemonServer({ env, onActivity: () => {}, onDrain: () => {}, ...routes });
	cleanup.push(() => server.close());
	cleanup.push(() => signIns.closeAll());
	workspaces.register(sharedAgentDb(env).db, { id: REPO_KEY, name: "demo", root, binding: "mock" });
	const store = new BacklogStore(() => sharedAgentDb(env), REPO_KEY);
	store.add({ title: "Shared item", goal: "Edited from both pages", createdBy: "tester" }, { id: "tester" });
	const boardChanged = vi.fn();
	const endpoint = await startAttachServer(
		{
			sessionId: "sess-1",
			cwd: root,
			repo: { key: REPO_KEY, name: "demo", root },
			workspace: fakeSession("sess-1").workspace,
			...(options.tools === false ? {} : { tools: () => DECLARED }),
			boardChanged,
		},
		env,
	);
	cleanup.push(() => endpoint.close());
	for (let tries = 0; tries < 40 && server.registry.attached === 0; tries++) {
		await server.registry.refresh();
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	expect(server.registry.attached).toBe(1);
	const call = (token: string, route: string, body?: unknown) =>
		fetch(`http://127.0.0.1:${server.port}${route}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { env, root, server, store, call, boardChanged };
}

const row = (list: ToolExposureList, group: string, name: string) =>
	list.groups.find((entry) => entry.name === group)?.tools.find((entry) => entry.name === name);

describe("an attached session's Settings on the daemon page", () => {
	it("lists what the running session declares, which the daemon alone cannot know", async () => {
		const { server, call } = await setup();
		const scoped = await call(server.token, "/s/sess-1/api/admin/config/tools?repoId=session");
		expect(scoped.status).toBe(200);
		const live = (await scoped.json()) as ToolExposureList;
		expect(live.live).toBe(true);
		expect(row(live, "native", "web")).toMatchObject({ state: "deferred" });
		expect(row(live, "native", "archive")).toMatchObject({ state: "direct" });
		expect(row(live, "native", "read")).toMatchObject({ state: "direct", decidedBy: "core" });
		expect(live.groups.find((group) => group.name === "ext")).toMatchObject({ pinnable: false });
		expect(row(live, "ext", "run")).toMatchObject({ state: "deferred", decidedBy: "recent" });

		// The daemon's own Settings page has no session: it can only say what a new session would declare.
		const top = (await (await call(server.token, "/api/admin/config/tools")).json()) as ToolExposureList;
		expect(top.live).toBe(false);
		expect(row(top, "native", "read")).toBeUndefined();

		// A pin from the session's page answers with the session's states too.
		const pinned = await call(server.token, "/s/sess-1/api/admin/config/tools", {
			kind: "native",
			tool: "web",
			pin: "direct",
			scope: "global",
			repoId: "session",
		});
		expect(pinned.status).toBe(200);
		const after = (await pinned.json()) as ToolExposureList;
		expect(after.live).toBe(true);
		// The running session keeps what it declared; the pin waits for the next session.
		expect(row(after, "native", "web")).toMatchObject({ pin: "direct", state: "deferred" });
	});

	it("resolves only the session's own workspace and keeps admin routes to the launch token", async () => {
		const { server, call } = await setup();
		expect((await call(server.token, "/s/sess-1/api/admin/config/tools?repoId=other")).status).toBe(404);
		expect((await call(server.token, `/s/sess-1/api/admin/config/tools?repoId=${REPO_KEY}`)).status).toBe(404);
		for (const token of [server.remoteToken, server.viewToken]) {
			expect((await call(token, "/s/sess-1/api/admin/config/tools?repoId=session")).status).toBe(403);
			expect((await call(token, "/s/sess-1/api/admin/drain", {})).status).toBe(403);
		}
		expect((await call(server.token, "/s/sess-unknown/api/admin/config/tools")).status).toBe(404);
	});

	it("falls back to the configuration's view for a session that cannot say (an older build)", async () => {
		const { server, call } = await setup({ tools: false });
		const answer = await call(server.token, "/s/sess-1/api/admin/config/tools?repoId=session");
		expect(answer.status).toBe(200);
		expect(((await answer.json()) as ToolExposureList).live).toBe(false);
	});
});

describe("board edits on the daemon page", () => {
	it("repaint the footer of the repository's attached sessions after a saved change only", async () => {
		const { server, call, store, boardChanged } = await setup();
		const [item] = store.list().items;
		const update = { op: "update", id: item.ref, version: item.version, title: "Renamed on the session page" };
		expect((await call(server.token, "/s/sess-1/api/backlogs", update)).status).toBe(200);
		await vi.waitFor(() => expect(boardChanged).toHaveBeenCalledTimes(1));
		// A stale version changes nothing, so nothing repaints.
		expect((await call(server.token, "/s/sess-1/api/backlogs", update)).status).toBe(409);
		// The repository's page has no session of its own; its sessions repaint all the same.
		const added = await call(server.token, `/r/${REPO_KEY}/api/backlogs`, { op: "add", title: "From the repo page" });
		expect(added.status).toBe(200);
		await vi.waitFor(() => expect(boardChanged).toHaveBeenCalledTimes(2));
	});

	it("record the same author as an edit on the session's own server", async () => {
		const { env, root, server, call, store } = await setup();
		const edit = async (send: (body: unknown) => Promise<Response>, title: string) => {
			const item = store.get(store.list().items[0].ref)!;
			expect((await send({ op: "update", id: item.ref, version: item.version, title })).status).toBe(200);
			return store.audit(item.ref, 1)[0].actor;
		};
		const viaDaemon = await edit((body) => call(server.token, "/s/sess-1/api/backlogs", body), "Daemon title");
		const own = await startWorkspaceWeb({
			store: new BacklogStore(() => sharedAgentDb(env), REPO_KEY),
			actor: { id: "sess-1", surface: "tool" },
			session: "sess-1",
			repoName: "demo",
			repoRoot: root,
		});
		cleanup.push(() => own.close());
		const ownUrl = new URL(own.url);
		const token = new URLSearchParams(ownUrl.hash.slice(1)).get("access")!;
		const viaOwn = await edit(
			(body) =>
				fetch(`${ownUrl.origin}/api/backlogs`, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
					body: JSON.stringify(body),
				}),
			"Session title",
		);
		expect(viaDaemon).toEqual({ id: "sess-1", kind: "human", surface: "web" });
		expect(viaOwn).toEqual(viaDaemon);
	});
});
