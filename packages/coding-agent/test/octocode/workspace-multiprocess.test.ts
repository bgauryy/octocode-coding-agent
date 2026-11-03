import { fixtureBacklog } from "./backlog-fixture.ts";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openAgentDb } from "../../src/config/database.ts";

const children: ChildProcess[] = [];
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		children.splice(0).map(async (child) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}),
	);
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function launch(root: string, session: string) {
	const child = fork(
		path.join(import.meta.dirname, "fixtures/workspace-process.ts"),
		[root, path.join(root, "db"), session],
		{
			execArgv: ["--import", path.join(import.meta.dirname, "../../scripts/source-resolver.ts")],
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		},
	);
	children.push(child);
	let errors = "";
	child.stderr?.on("data", (chunk) => {
		errors += String(chunk);
	});
	const ready = await new Promise<{ url: string; session: string }>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Workspace startup timed out: ${errors}`)), 10_000);
		child.once("message", (value) => {
			clearTimeout(timer);
			resolve(value as { url: string; session: string });
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", () => {
			clearTimeout(timer);
			reject(new Error(`Workspace exited: ${errors}`));
		});
	});
	return {
		...ready,
		request: async (route: string, payload?: unknown) => {
			const url = new URL(ready.url);
			const response = await fetch(new URL(route, url), {
				method: payload === undefined ? "GET" : "POST",
				headers: {
					Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("access")}`,
					Origin: url.origin,
					"Content-Type": "application/json",
				},
				body: payload === undefined ? undefined : JSON.stringify(payload),
				signal: AbortSignal.timeout(5000),
			});
			return { status: response.status, body: await response.json() };
		},
		close: async () => {
			const exited = once(child, "exit");
			child.send("close");
			await exited;
		},
		crash: async () => {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		},
	};
}

it("routes three live processes to their own sessions while synchronizing database entities", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-processes-"));
	roots.push(root);
	const db = openAgentDb(path.join(root, "db"));
	try {
		const item = fixtureBacklog(() => db, "shared-repo").add({ title: "Shared entity", createdBy: "user" });
		const sessions = await Promise.all(["first", "second", "third"].map((session) => launch(root, session)));
		expect(new Set(sessions.map((session) => session.url)).size).toBe(3);
		for (const session of sessions) {
			expect(await session.request("/api/workspace")).toMatchObject({
				status: 200,
				body: { sessionId: session.session },
			});
			expect(
				await session.request("/api/workspace", {
					id: `message-${session.session}`,
					action: "message",
					to: "test",
					text: "Hello",
				}),
			).toMatchObject({
				status: 200,
				body: { receipt: { message: `Delivered to ${session.session}` } },
			});
		}
		const edited = await sessions[0].request("/api/backlogs", {
			op: "update",
			id: item.ref,
			version: item.version,
			title: "Updated in first",
		});
		expect(edited.status).toBe(200);
		expect(
			await sessions[1].request("/api/backlogs", {
				op: "update",
				id: item.ref,
				version: item.version,
				title: "Stale edit",
			}),
		).toMatchObject({ status: 409 });
		for (const session of sessions.slice(1)) {
			expect(await session.request("/api/backlogs")).toMatchObject({
				status: 200,
				body: { items: [{ title: "Updated in first" }] },
			});
		}
		await sessions[0].crash();
		expect(await sessions[1].request("/api/workspace")).toMatchObject({ status: 200, body: { sessionId: "second" } });
		const reopened = await launch(root, "first");
		expect(await reopened.request("/api/backlogs")).toMatchObject({
			status: 200,
			body: { items: [{ title: "Updated in first" }] },
		});
		await sessions[1].close();
		expect(await sessions[2].request("/api/workspace")).toMatchObject({ status: 200, body: { sessionId: "third" } });
	} finally {
		db.close();
	}
});
