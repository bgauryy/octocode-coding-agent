import { fixtureBacklog } from "./backlog-fixture.ts";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAgentDb } from "../../src/storage/database.ts";
import { WORKSPACE_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { mermaidScript } from "@octocodeai/octocode-webview";
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

	it("serves the page with a script-hash CSP header, as the daemon does, and no 'unsafe-inline' script", async () => {
		const url = await board();
		const page = await fetch(new URL("/", url.origin));
		expect(page.status).toBe(200);
		const csp = page.headers.get("content-security-policy") ?? "";
		const scripts = csp.match(/script-src[^;]*/)![0];
		expect(scripts).not.toContain("unsafe-inline");
		expect(csp).toMatch(/default-src 'none'/);
		expect(csp).toMatch(/frame-ancestors 'none'/);
		expect(csp).toMatch(/connect-src 'self'/);
		expect(page.headers.get("x-content-type-options")).toBe("nosniff");
		const html = await page.text();
		expect(html).not.toContain(url.hash.slice("#access=".length));
		// The header names the hash of the one script the browser will run, so the page still loads it.
		const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
		expect(script).toContain("WorkspaceView.mountPage()");
		expect(scripts).toContain(`'sha256-${createHash("sha256").update(script).digest("base64")}'`);
		// The docs view runs the bundled Mermaid text as an inline script.
		expect(scripts).toContain(
			`'sha256-${createHash("sha256")
				.update(await mermaidScript())
				.digest("base64")}'`,
		);
		// A later render (new data) keeps the same script, so the header still covers it.
		const again = await (await fetch(new URL("/", url.origin))).text();
		expect(again.slice(again.indexOf("<script>") + "<script>".length, again.lastIndexOf("</script>"))).toBe(script);
	});

	it("accepts the bearer scheme in any letter case, as the daemon and the session API do", async () => {
		const url = await board();
		const token = url.hash.slice("#access=".length);
		for (const scheme of ["Bearer", "bearer", "BEARER"]) {
			const response = await fetch(new URL(WORKSPACE_ROUTES.backlogs, url.origin), {
				headers: { authorization: `${scheme} ${token}` },
			});
			expect(response.status).toBe(200);
		}
		const refused = await fetch(new URL(WORKSPACE_ROUTES.backlogs, url.origin), {
			headers: { authorization: "Bearer wrong" },
		});
		expect(refused.status).toBe(401);
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
