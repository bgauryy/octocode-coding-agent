import fs from "node:fs";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { AttachRecordSchema } from "@octocodeai/octocode-contracts/daemon";
import { AttachClient, STREAM_QUEUE_FRAMES } from "../../src/octocode/web-daemon/attach-client.ts";
import { startAttachServer, type AttachEndpoint } from "../../src/octocode/web-daemon/attach-server.ts";
import { attachRecordPath } from "../../src/octocode/web-daemon/paths.ts";
import { readAttachRecord } from "../../src/octocode/web-daemon/records.ts";
import { fakeSession, frame, isolatedEnv } from "./web-daemon-fixture.ts";

const repo = { key: "/repo/.git", name: "repo", root: "/repo" };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function endpoint(sessionId = "s1") {
	const { env } = isolatedEnv();
	const session = fakeSession(sessionId);
	const server: AttachEndpoint = await startAttachServer(
		{ sessionId, cwd: "/repo", repo, workspace: session.workspace },
		env,
	);
	cleanup.push(() => server.close());
	const file = attachRecordPath(env, sessionId);
	return { env, session, server, file, record: readAttachRecord(file)! };
}

/** Sends raw lines and collects the lines that come back until the socket closes. */
function raw(port: number, lines: string[]): Promise<{ replies: any[]; closed: boolean }> {
	return new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		let text = "";
		socket.on("data", (chunk) => (text += chunk));
		socket.on("close", () =>
			resolve({
				replies: text
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line)),
				closed: true,
			}),
		);
		socket.on("connect", () => {
			for (const line of lines) socket.write(line + "\n");
		});
		setTimeout(() => socket.end(), 300);
	});
}

describe("session attach endpoint", () => {
	it("writes an owner-only record with a per-run token and removes it on close", async () => {
		const { server, file, record } = await endpoint();
		expect(Value.Check(AttachRecordSchema, record)).toBe(true);
		expect(record.port).toBe(server.port);
		expect(record.token).toMatch(/^[0-9a-f]{64}$/);
		if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		await server.close();
		expect(fs.existsSync(file)).toBe(false);
	});

	it("rejects a wrong token, a missing hello and a protocol mismatch, and answers nothing else", async () => {
		const { record, session } = await endpoint();
		const hello = (token: string, protocolVersion = 1) =>
			JSON.stringify({ id: "1", method: "attach.hello", params: { token, protocolVersion } });
		const wrong = await raw(record.port, [hello("0".repeat(64))]);
		expect(wrong.replies).toEqual([
			{ id: "1", ok: false, error: { code: "unauthorized", message: "Wrong attach token." } },
		]);
		const first = await raw(record.port, [JSON.stringify({ id: "2", method: "workspace.snapshot" })]);
		expect(first.replies[0]).toMatchObject({ ok: false, error: { code: "unauthorized" } });
		const old = await raw(record.port, [hello(record.token, 2)]);
		expect(old.replies[0]).toMatchObject({ ok: false, error: { code: "protocol" } });
		expect(session.connects).toEqual([]);
		await expect(AttachClient.connect({ ...record, token: "x".repeat(64) })).rejects.toThrow(/token/i);
	});

	it("serves hello, snapshots, commands and revision to an authenticated daemon, and refuses unknown methods", async () => {
		const { record, session } = await endpoint();
		const client = await AttachClient.connect(record);
		cleanup.push(() => client.close());
		await expect(client.workspace.snapshot()).resolves.toMatchObject({ sessionId: "s1" });
		await expect(client.workspace.revision()).resolves.toBe("1");
		await expect(client.workspace.execute({ id: "c1", action: "stop", to: "a" })).resolves.toMatchObject({
			status: "accepted",
		});
		await expect(
			client.application.execute({ id: "p1", sessionId: "s1", action: "prompt", text: "hi" }),
		).resolves.toMatchObject({
			id: "p1",
			status: "accepted",
		});
		expect(session.executed).toHaveLength(1);
		await expect(client.application.history?.({ limit: 5 })).resolves.toMatchObject({ hasMore: false });
		await expect(client.request("shell.exec", { command: "id" })).rejects.toThrow(/Invalid attach request/);
		const { replies } = await raw(record.port, [
			JSON.stringify({ id: "1", method: "attach.hello", params: { token: record.token, protocolVersion: 1 } }),
			JSON.stringify({ id: "2", method: "application.readAsset", params: { id: "../../etc/passwd" } }),
		]);
		expect(replies[1]).toMatchObject({ ok: false, error: { code: "invalid" } });
	});

	it("streams application frames with a cursor, pushes workspace changes and says goodbye when the session ends", async () => {
		const { record, session, server } = await endpoint();
		const client = await AttachClient.connect(record);
		cleanup.push(() => client.close());
		const cursor = { sessionId: "s1", epoch: "e", sequence: 3 };
		const stream = client.application.connect({ sessionId: "s1", cursor });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(session.connects).toEqual([{ cursor }]);
		session.push(frame("s1", 4));
		const reader = stream[Symbol.asyncIterator]();
		expect((await reader.next()).value).toMatchObject({ type: "resumed", cursor: { sequence: 4 } });
		let changes = 0;
		client.onWorkspaceChange(() => changes++);
		await client.workspace.subscribe();
		session.changed();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(changes).toBe(1);
		const closed = new Promise<boolean>((resolve) => client.onClose(resolve));
		await server.close();
		await expect(closed).resolves.toBe(true);
		// A stream cut off by the session ends with one resync so the tab reconnects.
		const last = await reader.next();
		expect(last.value).toMatchObject({ type: "resync", reason: "session-changed" });
	});

	it("drops a slow tab's backlog and sends one resync instead of growing without bound", async () => {
		const { record, session } = await endpoint();
		const client = await AttachClient.connect(record);
		cleanup.push(() => client.close());
		const stream = client.application.connect({ sessionId: "s1" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		for (let sequence = 1; sequence <= STREAM_QUEUE_FRAMES + 50; sequence++) session.push(frame("s1", sequence));
		await new Promise((resolve) => setTimeout(resolve, 500));
		const seen: string[] = [];
		for await (const next of stream) seen.push(next.type + ":" + (next.type === "resync" ? next.reason : ""));
		expect(seen.length).toBeLessThanOrEqual(2);
		expect(seen.at(-1)).toBe("resync:overflow");
	});

	it("refuses an oversized request line without answering it", async () => {
		const { record } = await endpoint();
		const big = JSON.stringify({
			id: "1",
			method: "attach.hello",
			params: { token: "a".repeat(1024 * 1024 + 10), protocolVersion: 1 },
		});
		const { replies } = await raw(record.port, [big]);
		expect(replies).toEqual([]);
	});
});
