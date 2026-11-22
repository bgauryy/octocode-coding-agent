import { workspaces } from "../../../db/src/api.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ATTACH_MAX_EVENT_BYTES } from "@octocodeai/octocode-contracts/daemon";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { configureHttpDispatcher } from "../../src/core/http-dispatcher.ts";
import { AttachClient, STREAM_QUEUE_BYTES, STREAM_QUEUE_FRAMES } from "../../src/octocode/web-daemon/attach-client.ts";
import { startAttachServer, type AttachEndpoint } from "../../src/octocode/web-daemon/attach-server.ts";
import { ensureWebDaemon } from "../../src/octocode/web-daemon/launcher.ts";
import { daemonOpener } from "../../src/octocode/web-daemon/open.ts";
import { daemonSpawnOptions } from "../../src/octocode/web-daemon/spawn-env.ts";
import { LineReader } from "@octocodeai/octocode-common/line-splitter";
import { readAttachRecord, readDaemonRecord, writeAttachRecord } from "../../src/octocode/web-daemon/records.ts";
import { attachRecordPath, webDaemonPaths } from "../../src/octocode/web-daemon/paths.ts";
import { crashGuard } from "../../src/octocode/web-daemon/main.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { fakeCtx } from "./fake-host.ts";
import { fakeSession, frame, isolatedEnv } from "./web-daemon-fixture.ts";

const entry = fileURLToPath(new URL("../../src/octocode/web-daemon/entry.ts", import.meta.url));
const resolver = pathToFileURL(fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url))).href;
const invocation = () => ({ command: process.execPath, prefix: ["--import", resolver, entry] });
const repo = { key: "/repo/.git", name: "repo", root: "/repo" };

const cleanup: Array<() => Promise<void> | void> = [];
const pids = new Set<number>();
const uncaught: unknown[] = [];
const onUncaught = (error: unknown) => void uncaught.push(error);
beforeEach(() => {
	uncaught.length = 0;
	process.on("uncaughtException", onUncaught);
});
afterEach(async () => {
	process.off("uncaughtException", onUncaught);
	for (const fn of cleanup.splice(0).reverse()) await fn();
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	pids.clear();
});
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

async function endpoint(sessionId = "s1") {
	const { env } = isolatedEnv();
	const session = fakeSession(sessionId);
	const server: AttachEndpoint = await startAttachServer(
		{ sessionId, cwd: "/repo", repo, workspace: session.workspace },
		env,
	);
	cleanup.push(() => server.close());
	return { env, session, server, record: readAttachRecord(attachRecordPath(env, sessionId))! };
}

function rawLines(port: number, lines: string[], hold = 250): Promise<{ text: string; closed: boolean }> {
	return new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		let text = "";
		let closed = false;
		socket.on("data", (chunk) => (text += chunk));
		socket.on("close", () => (closed = true));
		socket.on("error", () => undefined);
		socket.on("connect", () => {
			for (const line of lines) socket.write(line + "\n");
		});
		setTimeout(() => {
			resolve({ text, closed });
			socket.destroy();
		}, hold);
	});
}

describe("F1: a malformed first line never reaches the agent process", () => {
	it("closes the socket for null, arrays, numbers, strings and bad shapes, and keeps serving the daemon", async () => {
		const { record } = await endpoint();
		for (const line of [
			"null",
			"[]",
			"5",
			'"x"',
			"true",
			'{"id":1,"method":"attach.hello"}',
			'{"method":"attach.hello","params":null}',
			"{",
		]) {
			const { closed } = await rawLines(record.port, [line]);
			expect(closed, line).toBe(true);
		}
		expect(uncaught).toEqual([]);
		const client = await AttachClient.connect(record);
		cleanup.push(() => client.close());
		await expect(client.workspace.snapshot()).resolves.toMatchObject({ sessionId: "s1" });
	});

	it("also survives malformed lines after authentication, closing only that connection", async () => {
		const { record } = await endpoint();
		const hello = JSON.stringify({
			id: "1",
			method: "attach.hello",
			params: { token: record.token, protocolVersion: 1 },
		});
		for (const bad of ["null", "[]", "7", '"x"']) {
			const { text, closed } = await rawLines(record.port, [hello, bad]);
			expect(text, bad).toContain('"id":"1"');
			expect(closed, bad).toBe(true);
		}
		expect(uncaught).toEqual([]);
		const client = await AttachClient.connect(record);
		cleanup.push(() => client.close());
		await expect(client.workspace.snapshot()).resolves.toMatchObject({ sessionId: "s1" });
	});
});

async function daemonServer(extra: { onActivity?: () => void } = {}) {
	const { env } = isolatedEnv();
	const server: DaemonServer = await startDaemonServer({
		env,
		onActivity: extra.onActivity ?? (() => {}),
		config: async () => ({}),
		onDrain: () => {},
	});
	cleanup.push(() => server.close());
	const origin = `http://127.0.0.1:${server.port}`;
	const health = async () => (await fetch(`${origin}/api/health`)).status;
	return { env, server, origin, health };
}

/** Sends a raw upgrade request line, optionally resetting the connection right after (RST). */
function rawUpgrade(
	port: number,
	target: string,
	options: { host?: string; origin?: string; reset?: boolean } = {},
): Promise<string> {
	return new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		let text = "";
		socket.on("data", (chunk) => (text += chunk));
		socket.on("error", () => undefined);
		socket.on("close", () => resolve(text));
		socket.on("connect", () => {
			socket.write(
				[
					`GET ${target} HTTP/1.1`,
					`Host: ${options.host ?? `127.0.0.1:${port}`}`,
					"Connection: Upgrade",
					"Upgrade: websocket",
					"Sec-WebSocket-Version: 13",
					"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
					...(options.origin ? [`Origin: ${options.origin}`] : []),
					"",
					"",
				].join("\r\n"),
			);
			if (options.reset) setImmediate(() => socket.resetAndDestroy());
			else setTimeout(() => socket.destroy(), 300);
		});
	});
}

describe("F2: nothing a peer sends before authentication can end the daemon", () => {
	it("answers an upgrade to `//` and other odd targets without throwing", async () => {
		const { server, health } = await daemonServer();
		for (const target of ["//", "///x", "//evil.example/s/a/api/backlogs/live", "http://127.0.0.1/", "*"]) {
			const text = await rawUpgrade(server.port, target);
			expect(text, target).toMatch(/^HTTP\/1\.1 (400|403|404)/);
		}
		expect(uncaught).toEqual([]);
		expect(await health()).toBe(200);
	});

	it("survives a reset after a rejected upgrade (wrong host, unknown scope, wrong origin)", async () => {
		const { server, health } = await daemonServer();
		await rawUpgrade(server.port, "/s/x/api/backlogs/live", { host: "evil.example", reset: true });
		await rawUpgrade(server.port, "/s/unknown/api/backlogs/live", { reset: true });
		await rawUpgrade(server.port, "/r/unknown/api/backlogs/live", { origin: "https://evil.example", reset: true });
		await rawUpgrade(server.port, "//", { reset: true });
		await settle();
		expect(uncaught).toEqual([]);
		expect(await health()).toBe(200);
	});

	it("refuses an HTTP request target that is protocol-relative or absolute, and a scoped rest of `//`", async () => {
		const { server, health } = await daemonServer();
		const get = (target: string) =>
			new Promise<number>((resolve, reject) => {
				const request = http.request(
					{ host: "127.0.0.1", port: server.port, path: target, headers: { host: `127.0.0.1:${server.port}` } },
					(response) => {
						response.resume();
						response.on("end", () => resolve(response.statusCode ?? 0));
					},
				);
				request.on("error", reject);
				request.end();
			});
		expect(await get("//")).toBe(400);
		expect(await get("//evil.example/")).toBe(400);
		expect(await get("/s/abc//")).toBe(401);
		const authed = (target: string) =>
			fetch(`http://127.0.0.1:${server.port}${target}`, { headers: { Authorization: `Bearer ${server.token}` } }).then(
				(r) => r.status,
			);
		expect(await authed("/s/abc//")).toBe(404);
		expect(await authed("/r/abc//x/api/reports")).toBe(404);
		expect(await health()).toBe(200);
	});

	it("keeps the real daemon process serving after each probe (crash probes against __web-daemon)", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5" });
		const daemon = await ensureWebDaemon({ env, invocation: invocation() });
		pids.add(daemon.record.pid);
		const port = new URL(daemon.origin).port;
		await rawUpgrade(Number(port), "//");
		await rawUpgrade(Number(port), "/s/x/api/backlogs/live", { host: "evil.example", reset: true });
		await rawUpgrade(Number(port), "/s/unknown/api/backlogs/live", { reset: true });
		await settle(400);
		expect((await fetch(`${daemon.origin}/api/health`)).status).toBe(200);
		expect(readDaemonRecord(webDaemonPaths(env).record)?.pid).toBe(daemon.record.pid);
		const { record } = await endpoint();
		await rawLines(record.port, ["null"]);
	});
});

describe("F3: the daemon token never goes through a proxy", () => {
	it("reaches the daemon directly when HTTP_PROXY is set and the global dispatcher honors it", async () => {
		const seen: string[] = [];
		const proxy = http.createServer((req, res) => {
			seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
			res.writeHead(502).end();
		});
		proxy.on("connect", (req, socket) => {
			seen.push(`CONNECT ${req.url}`);
			socket.destroy();
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		cleanup.push(() => new Promise<void>((resolve) => void proxy.close(() => resolve())));
		const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
		const previous = {
			http: process.env.HTTP_PROXY,
			lower: process.env.http_proxy,
			no: process.env.NO_PROXY,
			noLower: process.env.no_proxy,
		};
		process.env.HTTP_PROXY = proxyUrl;
		process.env.http_proxy = proxyUrl;
		delete process.env.NO_PROXY;
		delete process.env.no_proxy;
		configureHttpDispatcher();
		cleanup.push(() => {
			for (const [name, value] of [
				["HTTP_PROXY", previous.http],
				["http_proxy", previous.lower],
				["NO_PROXY", previous.no],
				["no_proxy", previous.noLower],
			] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			configureHttpDispatcher();
		});
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5" });
		const daemon = await ensureWebDaemon({ env, invocation: invocation() });
		pids.add(daemon.record.pid);
		const again = await ensureWebDaemon({ env, invocation: invocation() });
		expect(again.record.nonce).toBe(daemon.record.nonce);
		expect(seen).toEqual([]);
		expect(JSON.stringify(seen)).not.toContain(daemon.token);
	});
});

describe("F4: lines survive any chunk boundary", () => {
	it("decodes a multi-byte line split at every byte offset", () => {
		const line = JSON.stringify({ text: "héllo 日本語 🙂 ok" });
		const bytes = Buffer.from(line + "\n");
		for (let split = 1; split < bytes.length; split++) {
			const lines: string[] = [];
			const reader = new LineReader(
				1024,
				(value) => lines.push(value),
				() => undefined,
			);
			reader.push(bytes.subarray(0, split));
			reader.push(bytes.subarray(split));
			expect(lines, `split at ${split}`).toEqual([line]);
		}
	});

	it("keeps a split sequence across three chunks and several lines", () => {
		const bytes = Buffer.from("🙂🙂\n日本\n");
		const lines: string[] = [];
		const reader = new LineReader(
			1024,
			(value) => lines.push(value),
			() => undefined,
		);
		for (let index = 0; index < bytes.length; index++) reader.push(bytes.subarray(index, index + 1));
		expect(lines).toEqual(["🙂🙂", "日本"]);
	});
});

describe("F5: caps and byte-bounded queues", () => {
	it("never sends a session event above the event cap: an oversized frame becomes one resync for that stream", async () => {
		const { record, session } = await endpoint();
		const client = await AttachClient.connect(record);
		cleanup.push(() => client.close());
		const stream = client.application.connect({ sessionId: "s1" });
		await settle(100);
		const huge = {
			...frame("s1", 1),
			type: "event",
			event: { type: "message.delta", messageId: "m", text: "x".repeat(ATTACH_MAX_EVENT_BYTES + 10) },
		};
		session.push(huge as never);
		const reader = stream[Symbol.asyncIterator]();
		const first = await reader.next();
		expect(first.value).toMatchObject({ type: "resync", reason: "overflow" });
		expect(JSON.stringify(first.value).length).toBeLessThan(1000);
		expect((await reader.next()).done).toBe(true);
		// Another stream and the connection are unaffected.
		await expect(client.workspace.snapshot()).resolves.toMatchObject({ sessionId: "s1" });
	});

	it("drops an oversized unsolicited line from a misbehaving session without growing a queue", async () => {
		const sessionId = "evil";
		const server = net.createServer((socket) => {
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk;
				for (const line of buffer.split("\n").slice(0, -1)) {
					const request = JSON.parse(line) as { id: string; method: string; params?: { streamId?: string } };
					socket.write(
						JSON.stringify({
							id: request.id,
							ok: true,
							...(request.method === "attach.hello"
								? { result: { sessionId, protocolVersion: 1, capabilities: [] } }
								: {}),
						}) + "\n",
					);
					if (request.method === "application.connect")
						socket.write(
							`{"event":"application.frame","streamId":"${request.params!.streamId}","frame":{"pad":"${"x".repeat(ATTACH_MAX_EVENT_BYTES + 50)}"}}\n`,
						);
				}
				buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
			});
			socket.on("error", () => undefined);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanup.push(() => new Promise<void>((resolve) => void server.close(() => resolve())));
		const client = await AttachClient.connect({
			protocolVersion: 1,
			sessionId,
			pid: process.pid,
			port: (server.address() as AddressInfo).port,
			token: "t",
			cwd: "/",
			repo,
			startedAt: 1,
		});
		cleanup.push(() => client.close());
		const stream = client.application.connect({ sessionId });
		const reader = stream[Symbol.asyncIterator]();
		expect((await reader.next()).value).toMatchObject({ type: "resync", reason: "overflow" });
		expect(client.connected).toBe(true);
	});

	it("bounds a stream's queue by bytes as well as frames, then resyncs that stream only", async () => {
		const { record, session } = await endpoint();
		const client = await AttachClient.connect(record);
		cleanup.push(() => client.close());
		const slow = client.application.connect({ sessionId: "s1" });
		await settle(100);
		const pad = "y".repeat(Math.floor(ATTACH_MAX_EVENT_BYTES * 0.9));
		const fat = (sequence: number) => ({
			...frame("s1", sequence),
			type: "event",
			event: { type: "message.delta", messageId: "m", text: pad },
		});
		const frames = Math.ceil(STREAM_QUEUE_BYTES / pad.length) + 3;
		expect(frames).toBeLessThan(STREAM_QUEUE_FRAMES);
		for (let sequence = 1; sequence <= frames; sequence++) session.push(fat(sequence) as never);
		await settle(900);
		const seen: Array<{ type: string }> = [];
		for await (const next of slow) seen.push(next);
		expect(seen.at(-1)).toMatchObject({ type: "resync", reason: "overflow" });
		expect(seen.length).toBeLessThan(frames);
		await expect(client.workspace.snapshot()).resolves.toMatchObject({ sessionId: "s1" });
	});
});

describe("F7: unauthenticated sockets cannot crowd out or keep alive the daemon", () => {
	it("lets an authenticated hello through while many unauthenticated attach sockets are open", async () => {
		const { record } = await endpoint();
		const idle = await Promise.all(
			Array.from(
				{ length: 40 },
				() =>
					new Promise<net.Socket>((resolve) => {
						const socket = net.connect({ host: "127.0.0.1", port: record.port }, () => resolve(socket));
						socket.on("error", () => undefined);
					}),
			),
		);
		cleanup.push(() => idle.forEach((socket) => socket.destroy()));
		const client = await AttachClient.connect(record);
		cleanup.push(() => client.close());
		await expect(client.workspace.snapshot()).resolves.toMatchObject({ sessionId: "s1" });
	});

	it("neither fills the tab limit nor resets the idle timer before a token is accepted", async () => {
		const onActivity = vi.fn();
		const { server, origin, env } = await daemonServer({ onActivity });
		const key = crypto.randomUUID();
		fixtureBacklog(() => sharedAgentDb(env), key).add({ title: "t", goal: "g", createdBy: "t" }, { id: "t" });
		const url = `ws://127.0.0.1:${server.port}/r/${key}/api/backlogs/live`;
		const open = () =>
			new Promise<WebSocket>((resolve) => {
				const socket = new WebSocket(url, { headers: { Origin: origin } });
				cleanup.push(() => socket.terminate());
				socket.on("open", () => resolve(socket));
				socket.on("error", () => undefined);
			});
		const idle = await Promise.all(Array.from({ length: 80 }, open));
		await settle(100);
		expect(onActivity).not.toHaveBeenCalled();
		expect(server.tabs.count).toBe(0);
		const good = await open();
		const packets: Array<{ type: string }> = [];
		good.on("message", (data) => packets.push(JSON.parse(String(data))));
		good.send(JSON.stringify({ token: server.token, protocolVersion: 1 }));
		await vi.waitFor(() => expect(packets.some((packet) => packet.type === "snapshot")).toBe(true));
		expect(server.tabs.count).toBe(1);
		expect(onActivity).toHaveBeenCalled();
		void idle;
	});
});

describe("F8: long lists are truncated, not refused", () => {
	it("lists 200 repositories with a flag and clamps long names when more exist", async () => {
		const { env } = isolatedEnv();
		const server = await startDaemonServer({ env, onActivity: () => {}, config: async () => ({}), onDrain: () => {} });
		cleanup.push(() => server.close());
		for (let index = 0; index < 230; index++) {
			const name = "n".repeat(index === 0 ? 300 : 1) + index;
			workspaces.register(sharedAgentDb(env).db, {
				id: crypto.randomUUID(),
				name,
				root: "/work/" + name,
				binding: String(index),
			});
		}
		const response = await fetch(`http://127.0.0.1:${server.port}/api/repos`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { repos: Array<{ name: string }>; truncated?: boolean };
		expect(body.repos).toHaveLength(200);
		expect(body.truncated).toBe(true);
		expect(Math.max(...body.repos.map((repoRow) => repoRow.name.length))).toBeLessThanOrEqual(256);
	});
});

describe("F6: only an older daemon is drained", () => {
	it("reuses a newer daemon for an older launcher, without asking it to drain", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5" });
		const current = await ensureWebDaemon({ env, invocation: invocation() });
		pids.add(current.record.pid);
		const older = await ensureWebDaemon({ env, build: "0.0.1:older", invocation: invocation() });
		expect(older.record.nonce).toBe(current.record.nonce);
		const status = await (
			await fetch(`${current.origin}/api/health`, { headers: { Authorization: `Bearer ${current.token}` } })
		).json();
		expect(status.draining).toBe(false);
		expect(readDaemonRecord(webDaemonPaths(env).record)?.nonce).toBe(current.record.nonce);
	});

	it("lists a session that speaks an older attach protocol with a clear restart message", async () => {
		const { env } = isolatedEnv();
		const refusing = net.createServer((socket) => {
			socket.on("data", (chunk) => {
				const request = JSON.parse(String(chunk).split("\n")[0]) as { id: string };
				socket.write(
					JSON.stringify({
						id: request.id,
						ok: false,
						error: { code: "protocol", message: "Unsupported attach protocol; restart this session to connect." },
					}) + "\n",
				);
				socket.end();
			});
			socket.on("error", () => undefined);
		});
		await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve));
		cleanup.push(() => new Promise<void>((resolve) => void refusing.close(() => resolve())));
		writeAttachRecord(attachRecordPath(env, "old-session"), {
			protocolVersion: 1,
			sessionId: "old-session",
			pid: process.pid,
			port: (refusing.address() as AddressInfo).port,
			token: "t",
			cwd: "/work/old",
			repo,
			startedAt: 1,
		});
		const server = await startDaemonServer({ env, onActivity: () => {}, config: async () => ({}), onDrain: () => {} });
		cleanup.push(() => server.close());
		await vi.waitFor(async () => {
			const body = await (
				await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
					headers: { Authorization: `Bearer ${server.token}` },
				})
			).json();
			expect(body.sessions).toEqual([]);
			expect(body.unavailable).toEqual([
				expect.objectContaining({ id: "old-session", message: expect.stringMatching(/restart it/i) }),
			]);
		});
	});
});

describe("F9: smaller items", () => {
	it("starts the daemon with a minimal environment and the Octocode home as its folder", () => {
		const { env, cwd } = daemonSpawnOptions({
			HOME: "/home/u",
			PATH: "/usr/bin",
			LANG: "C",
			LC_ALL: "C",
			NODE_OPTIONS: "--no-warnings",
			NODE_COMPILE_CACHE: "/shared/compile-cache",
			NODE_DISABLE_COMPILE_CACHE: "1",
			OCTOCODE_HOME: "/h",
			OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "3",
			OCTOCODE_API_TOKEN: "leak-1",
			OCTOCODE_GITHUB_KEY: "leak-2",
			OPENAI_API_KEY: "sk-sentinel-value",
			GITHUB_TOKEN: "leak-3",
			AWS_SECRET_ACCESS_KEY: "leak-4",
			HTTP_PROXY: "http://user:pass@proxy:8080",
			HTTPS_PROXY: "http://proxy",
			NPM_TOKEN: "leak-5",
		});
		expect(env).toMatchObject({
			HOME: "/home/u",
			PATH: "/usr/bin",
			LANG: "C",
			LC_ALL: "C",
			OCTOCODE_HOME: "/h",
			OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "3",
			NODE_OPTIONS: "--no-warnings",
			NODE_COMPILE_CACHE: "/shared/compile-cache",
			NODE_DISABLE_COMPILE_CACHE: "1",
		});
		expect(env.OPENAI_API_KEY).toBe("set");
		expect(JSON.stringify(env)).not.toMatch(/leak-|sentinel|user:pass/);
		for (const name of [
			"GITHUB_TOKEN",
			"AWS_SECRET_ACCESS_KEY",
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"NPM_TOKEN",
			"OCTOCODE_API_TOKEN",
			"OCTOCODE_GITHUB_KEY",
		])
			expect(env[name], name).toBeUndefined();
		expect(cwd).toBe("/h");
	});

	it("still tells the Settings page that an environment key is set, without the daemon holding its value", async () => {
		const { env } = isolatedEnv({
			OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5",
			OPENAI_API_KEY: "sk-sentinel-value-12345",
			SOME_UNRELATED_TOKEN: "leak",
		});
		const daemon = await ensureWebDaemon({ env, invocation: invocation() });
		pids.add(daemon.record.pid);
		const response = await fetch(`${daemon.origin}/api/config`, {
			headers: { Authorization: `Bearer ${daemon.token}` },
		});
		const text = await response.text();
		expect(response.status).toBe(200);
		expect(text).not.toContain("sk-sentinel-value-12345");
		const openai = (
			JSON.parse(text) as {
				providers: Array<{ provider: string; configured: boolean; sources: Array<{ kind: string; envVar?: string }> }>;
			}
		).providers.find((row) => row.provider === "openai");
		expect(openai).toMatchObject({
			configured: true,
			sources: expect.arrayContaining([{ kind: "env", envVar: "OPENAI_API_KEY" }]),
		});
	});

	it("makes /web fall back when the daemon never lists this session", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON: "1", OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5" });
		const open = vi.fn(async () => {});
		const opener = daemonOpener(
			{ ensure: async () => ({ sessionId: "ghost", port: 1, close: async () => {} }) },
			{ env, invocation: invocation(), open, sessionWaitMs: 400 },
		);
		const record = () => readDaemonRecord(webDaemonPaths(env).record);
		cleanup.push(() => {
			if (record()) pids.add(record()!.pid);
		});
		await expect(opener(fakeCtx({ cwd: "/tmp" }), "board")).rejects.toThrow(/did not attach/);
		expect(open).not.toHaveBeenCalled();
	});

	it("forgets a session's remembered workspace when its last tab closes", async () => {
		const { env } = isolatedEnv();
		const session = fakeSession("sess-w");
		const key = crypto.randomUUID();
		fixtureBacklog(() => sharedAgentDb(env), key).add({ title: "t", goal: "g", createdBy: "t" }, { id: "t" });
		const endpoint2 = await startAttachServer(
			{
				sessionId: "sess-w",
				cwd: "/work/f9",
				repo: { key, name: "f9", root: "/work/f9" },
				workspace: session.workspace,
			},
			env,
		);
		cleanup.push(() => endpoint2.close());
		const server = await startDaemonServer({ env, onActivity: () => {}, config: async () => ({}), onDrain: () => {} });
		cleanup.push(() => server.close());
		await vi.waitFor(() => expect(server.registry.attached).toBe(1));
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/s/sess-w/api/backlogs/live`, {
			headers: { Origin: `http://127.0.0.1:${server.port}` },
		});
		cleanup.push(() => socket.terminate());
		await new Promise<void>((resolve) => socket.on("open", () => resolve()));
		socket.send(JSON.stringify({ token: server.token, protocolVersion: 1 }));
		await vi.waitFor(() => expect(server.tabs.trackedWorkspaces).toBe(1));
		socket.close();
		await vi.waitFor(() => expect(server.tabs.trackedWorkspaces).toBe(0));
		await settle(700);
		expect(server.tabs.trackedWorkspaces).toBe(0);
	});

	it("removes attach records of dead pids, at the next session start and at the daemon's session scan", async () => {
		const { env } = isolatedEnv();
		const dead = (name: string) => {
			const file = attachRecordPath(env, name);
			writeAttachRecord(file, {
				protocolVersion: 1,
				sessionId: name,
				pid: 2 ** 22 + 4321,
				port: 9,
				token: "t",
				cwd: "/",
				repo,
				startedAt: 1,
			});
			return file;
		};
		const first = dead("crashed-1");
		const session = fakeSession("alive");
		const live = await startAttachServer({ sessionId: "alive", cwd: "/", repo, workspace: session.workspace }, env);
		cleanup.push(() => live.close());
		expect(fs.existsSync(first)).toBe(false);
		const second = dead("crashed-2");
		const server = await startDaemonServer({ env, onActivity: () => {}, config: async () => ({}), onDrain: () => {} });
		cleanup.push(() => server.close());
		await server.registry.refresh();
		expect(fs.existsSync(second)).toBe(false);
		expect(fs.existsSync(attachRecordPath(env, "alive"))).toBe(true);
	});
});

describe("F2: the daemon's safety net", () => {
	it("logs an uncaught error with secrets redacted and keeps serving, but stops on a burst", () => {
		const lines: string[] = [];
		const stop = vi.fn();
		let now = 1_000_000;
		const guard = crashGuard({ log: { write: (text) => void lines.push(text) }, stop, now: () => now });
		const handler = guard("uncaughtException");
		handler(new Error("boom with key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("uncaughtException: Error: boom");
		expect(lines[0]).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
		for (let index = 0; index < 19; index++) handler(new Error("again"));
		expect(stop).not.toHaveBeenCalled();
		handler(new Error("one too many"));
		expect(stop).toHaveBeenCalledTimes(1);
		now += 120_000;
		stop.mockClear();
		for (let index = 0; index < 5; index++) handler("spread out");
		expect(stop).not.toHaveBeenCalled();
	});
});
