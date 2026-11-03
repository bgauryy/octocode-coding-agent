import { fixtureBacklog } from "./backlog-fixture.ts";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAgentDb } from "../../src/config/database.ts";
import { WORKSPACE_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import type { RevisedWorkspace } from "../../src/octocode/workspace/revision.ts";
import { startWorkspaceWeb } from "../../src/octocode/workspace/server.ts";

/** The per-session board on a real loopback socket: nothing a peer sends before authentication may end the session. */
const cleanup: Array<() => Promise<void> | void> = [];
const uncaught: unknown[] = [];
const onUncaught = (error: unknown) => void uncaught.push(error);
beforeEach(() => {
	uncaught.length = 0;
	process.on("uncaughtException", onUncaught);
});
afterEach(async () => {
	process.off("uncaughtException", onUncaught);
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function board(prepare?: (root: string) => void, workspace?: RevisedWorkspace) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-loopback-"));
	prepare?.(directory);
	const db = openAgentDb(path.join(directory, "db"));
	const store = fixtureBacklog(() => db, "repo");
	const web = await startWorkspaceWeb(
		{
			store,
			actor: { id: "s1" },
			session: "s1",
			repoName: "repo",
			repoRoot: directory,
		},
		undefined,
		workspace,
	);
	cleanup.push(() => {
		db.close();
		fs.rmSync(directory, { recursive: true, force: true });
	});
	cleanup.push(() => web.close());
	return new URL(web.url);
}

const authorized = (url: URL, route: string) =>
	fetch(new URL(route, url.origin), { headers: { authorization: `Bearer ${url.hash.slice("#access=".length)}` } });

/** Sends an upgrade request and resets the connection right after it, before the refusal can be written. */
function resetUpgrade(port: number, target: string, headers: string[]): Promise<void> {
	return new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		socket.on("error", () => undefined);
		socket.on("close", () => resolve());
		socket.on("connect", () => {
			socket.write(
				[
					`GET ${target} HTTP/1.1`,
					...headers,
					"Connection: Upgrade",
					"Upgrade: websocket",
					"Sec-WebSocket-Version: 13",
					"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
					"",
					"",
				].join("\r\n"),
			);
			setImmediate(() => socket.resetAndDestroy());
		});
	});
}

describe("per-session board over loopback", () => {
	it("survives peers that reset after a refused upgrade (wrong origin, wrong host, wrong route)", async () => {
		const url = await board();
		const port = Number(url.port);
		for (let round = 0; round < 20; round++) {
			await resetUpgrade(port, "/api/backlogs/live", [`Host: ${url.host}`, "Origin: https://evil.example"]);
			await resetUpgrade(port, "/api/backlogs/live", ["Host: evil.example", `Origin: ${url.origin}`]);
			await resetUpgrade(port, "/elsewhere", [`Host: ${url.host}`, `Origin: ${url.origin}`]);
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(uncaught).toEqual([]);
		const health = await fetch(new URL("/", url.origin));
		expect(health.status).toBe(200);
	});

	it("does not serve reports through a symbolic link that leaves .octocode/", async () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-outside-"));
		cleanup.push(() => fs.rmSync(outside, { recursive: true, force: true }));
		fs.mkdirSync(path.join(outside, "leak"));
		fs.writeFileSync(path.join(outside, "leak", "secret.md"), "# Outside the workspace\n");
		const url = await board((root) => {
			fs.mkdirSync(path.join(root, ".octocode"));
			fs.mkdirSync(path.join(root, ".octocode", "octocode-research", "real"), { recursive: true });
			fs.writeFileSync(path.join(root, ".octocode", "octocode-research", "real", "notes.md"), "# Inside\n");
			fs.symlinkSync(outside, path.join(root, ".octocode", "octocode-rfc-generator"));
		});
		const index = (await (await authorized(url, "/api/reports")).json()) as { reports: Array<{ id: string }> };
		expect(index.reports.map((report) => report.id)).toEqual(["real"]);
		const file = await authorized(url, "/api/reports/file?id=leak&kind=rfc&name=secret.md");
		expect(file.status).toBe(404);
	});

	it("redacts secrets from a failed command's error reply, as the daemon does", async () => {
		const secret = `ghp_${"a1".repeat(18)}`;
		const workspace = {
			snapshot: () => ({ sessionId: "s1", agents: [], traffic: [], events: [], receipts: [] }),
			execute: () => Promise.reject(new Error(`push failed: remote said token ${secret} is expired`)),
			subscribe: () => () => undefined,
			close: () => undefined,
		} as unknown as RevisedWorkspace;
		const url = await board(undefined, workspace);
		const response = await fetch(new URL(WORKSPACE_ROUTES.workspace, url.origin), {
			method: "POST",
			headers: {
				authorization: `Bearer ${url.hash.slice("#access=".length)}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ id: "c1", action: "stop", to: "a1" }),
		});
		expect(response.status).toBe(409);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("push failed");
		expect(body.error).not.toContain(secret);
	});
});
