import { fixtureBacklog } from "./backlog-fixture.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ApplicationAssets } from "../../src/core/application/assets.ts";
import { startWorkspaceWeb } from "../../src/octocode/workspace/server.ts";
import { openAgentDb } from "../../src/config/database.ts";
import type { ApplicationPort, WorkspaceConnection } from "@octocodeai/octocode-contracts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.reverse()) await close();
	cleanup.length = 0;
});

async function setup() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "application-assets-http-"));
	cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
	const db = openAgentDb(path.join(directory, "db"));
	cleanup.push(() => db.close());
	const store = fixtureBacklog(() => db, "repo");
	const assets = new ApplicationAssets();
	cleanup.push(() => assets.clear());
	const port: ApplicationPort = {
		connect: () => {
			throw new Error("This HTTP fixture does not connect a stream");
		},
		execute: async (command) => ({ id: command.id, status: "accepted" }),
		readAsset: (id) => assets.get(id),
		uploadAsset: (input) => assets.upload(input),
		history: () => ({
			messages: [{ id: "message", role: "user", text: "hello", complete: true }],
			tools: [],
			hasMore: false,
		}),
	};
	const workspace: WorkspaceConnection = {
		application: port,
		snapshot: () => ({ sessionId: "session", agents: [], traffic: [], events: [], receipts: [] }),
		execute: async () => {
			throw new Error("Not used");
		},
		subscribe: () => () => {},
		close: () => {},
	};
	const web = await startWorkspaceWeb(
		{ store, actor: { id: "parent" }, session: "session", repoName: "repo", repoRoot: directory },
		() => {},
		workspace,
	);
	cleanup.push(() => web.close());
	const url = new URL(web.url);
	const headers = { Authorization: `Bearer ${url.hash.slice(8)}`, "Content-Type": "application/json" };
	return { assets, origin: url.origin, headers };
}

it("uploads and reads an image only through authenticated session-scoped routes", async () => {
	const { origin, headers } = await setup();
	const body = JSON.stringify({ sessionId: "session", mimeType: "image/png", data: "aW1hZ2U=", name: "sample.png" });
	expect((await fetch(`${origin}/api/application/assets`, { method: "POST", body })).status).toBe(401);
	const uploaded = await fetch(`${origin}/api/application/assets`, { method: "POST", headers, body });
	expect(uploaded.status).toBe(201);
	const { asset } = await uploaded.json();
	const target = `${origin}/api/application/assets/${asset.id}`;
	expect((await fetch(`${target}?sessionId=session`)).status).toBe(401);
	expect((await fetch(`${target}?sessionId=other`, { headers })).status).toBe(409);
	const result = await fetch(`${target}?sessionId=session`, { headers });
	expect(result.status).toBe(200);
	expect(await result.json()).toEqual({ asset, encoding: "base64", data: "aW1hZ2U=" });
	expect(result.headers.get("cache-control")).toBe("no-store");
	expect(
		(await fetch(`${origin}/api/application/assets/${"0".repeat(64)}?sessionId=session`, { headers })).status,
	).toBe(404);
	expect(
		(await fetch(target + "?sessionId=session", { headers: { ...headers, Origin: "https://example.com" } })).status,
	).toBe(403);
});

it("validates attachment authority and history cursors, and redacts full text assets", async () => {
	const { origin, headers, assets } = await setup();
	for (const input of [
		{ sessionId: "other", mimeType: "image/png", data: "aW1hZ2U=" },
		{ sessionId: "session", mimeType: "image/png", data: "aW1hZ2U=", path: "/private/file" },
		{ sessionId: "session", mimeType: "image/svg+xml", data: "aW1hZ2U=" },
	]) {
		const result = await fetch(`${origin}/api/application/assets`, {
			method: "POST",
			headers,
			body: JSON.stringify(input),
		});
		expect(result.status).toBe(input.sessionId === "other" ? 409 : 400);
	}
	const full = assets.put("before sk-" + "x".repeat(32) + " after", "text/plain");
	const result = await fetch(`${origin}/api/application/assets/${full.id}?sessionId=session`, { headers });
	expect((await result.json()).data).toBe("before [redacted] after");
	const history = await fetch(`${origin}/api/application/history?sessionId=session&limit=50`, { headers });
	expect(history.status).toBe(200);
	expect(await history.json()).toMatchObject({ messages: [{ role: "user", text: "hello" }], hasMore: false });
	expect((await fetch(`${origin}/api/application/history?sessionId=session&limit=101`, { headers })).status).toBe(400);
});
