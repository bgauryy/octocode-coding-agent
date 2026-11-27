import { fixtureBacklog } from "./backlog-fixture.ts";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAgentDb } from "../../src/storage/database.ts";
import type { Backlog, BacklogWeb } from "../../src/octocode/backlog/context.ts";
import { sharedWorkspaceWeb } from "../../src/octocode/backlog/shared-web.ts";
import { readRecord, registryPaths } from "../../src/octocode/backlog/shared-web-registry.ts";
import { startWorkspaceWeb } from "../../src/octocode/workspace/server.ts";

const childScript = fileURLToPath(new URL("./backlog-shared-web-child.ts", import.meta.url));
const registryPathsForTest = registryPaths;
const readRegistryRecord = (repoRoot: string, session: string, env?: NodeJS.ProcessEnv) =>
	readRecord(registryPaths(repoRoot, session, env).entry);

function fakeBacklog(repoRoot: string): Backlog {
	return {
		store: { repo: "repo" } as Backlog["store"],
		actor: { id: "test" },
		session: "session-test",
		repoName: "repo",
		repoRoot,
	};
}

async function fakeWorkspaceServer(token: string): Promise<BacklogWeb> {
	const server = createServer((req, res) => {
		const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
		if (req.url === "/api/backlogs" && req.method === "GET" && auth === token) {
			res.writeHead(200, { "content-type": "application/json" }).end("{}");
		} else {
			res.writeHead(401).end();
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/#access=${token}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

describe("sharedWorkspaceWeb controlled fakes", () => {
	let dir: string;
	let backlog: Backlog;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-web-"));
		backlog = fakeBacklog(dir);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("starts one server for concurrent callers and reuses it", async () => {
		let starts = 0;
		let closes = 0;
		const openWeb = async (): Promise<BacklogWeb> => {
			starts++;
			const server = await fakeWorkspaceServer(`concurrent-${starts}`);
			const originalClose = server.close;
			server.close = async () => {
				closes++;
				await originalClose();
			};
			return server;
		};
		const helper = sharedWorkspaceWeb(openWeb);
		const results = await Promise.all([
			helper({} as never, backlog, () => undefined),
			helper({} as never, backlog, () => undefined),
			helper({} as never, backlog, () => undefined),
		]);
		expect(starts).toBe(1);
		const urls = results.map((result) => result.url);
		expect(new Set(urls).size).toBe(1);

		// Close until the registry entry disappears: that caller owned the server.
		let ownerIndex = -1;
		for (let i = 0; i < results.length; i++) {
			await results[i].close();
			if ((await readRegistryRecord(dir, "session-test")) === undefined) {
				ownerIndex = i;
				break;
			}
		}
		expect(ownerIndex).not.toBe(-1);
		expect(closes).toBe(1);

		// The remaining closes are no-ops and idempotent.
		for (let i = ownerIndex + 1; i < results.length; i++) {
			await results[i].close();
		}
		expect(closes).toBe(1);
		expect(await readRegistryRecord(dir, "session-test")).toBeUndefined();
	});

	it("replaces a stale record whose pid is dead", async () => {
		let starts = 0;
		const openWeb = async (): Promise<BacklogWeb> => {
			starts++;
			return fakeWorkspaceServer(`fresh-${starts}`);
		};
		const { entry } = registryPathsForTest(dir, "session-test");
		fs.mkdirSync(path.dirname(entry), { recursive: true });
		fs.writeFileSync(entry, JSON.stringify({ url: "http://127.0.0.1:9/#access=stale", pid: 9_999_999 }));
		const helper = sharedWorkspaceWeb(openWeb);
		const web = await helper({} as never, backlog, () => undefined);
		expect(starts).toBe(1);
		expect(web.url).not.toContain("stale");
		await web.close();
	});

	it("replaces a stale record whose server does not answer", async () => {
		let starts = 0;
		const openWeb = async (): Promise<BacklogWeb> => {
			starts++;
			return fakeWorkspaceServer(`fresh-${starts}`);
		};
		const { entry } = registryPathsForTest(dir, "session-test");
		fs.mkdirSync(path.dirname(entry), { recursive: true });
		// The pid is live (this process) but the port is closed, so the probe must fail.
		fs.writeFileSync(entry, JSON.stringify({ url: "http://127.0.0.1:9/#access=stale", pid: process.pid }));
		const helper = sharedWorkspaceWeb(openWeb);
		const web = await helper({} as never, backlog, () => undefined);
		expect(starts).toBe(1);
		await web.close();
	});

	it("returns a no-op close for a reused server owned by another invocation", async () => {
		const ownerServer = await fakeWorkspaceServer("owner");
		const { entry } = registryPathsForTest(dir, "session-test");
		fs.mkdirSync(path.dirname(entry), { recursive: true });
		// Record a live pid so the helper attempts the probe; this invocation did not start the server,
		// so its close must be a no-op even though the recorded pid matches this process.
		fs.writeFileSync(entry, JSON.stringify({ url: ownerServer.url, pid: process.pid }));

		let starts = 0;
		const openWeb = async (): Promise<BacklogWeb> => {
			starts++;
			return fakeWorkspaceServer("should-not-start");
		};
		const helper = sharedWorkspaceWeb(openWeb);
		const reused = await helper({} as never, backlog, () => undefined);
		expect(starts).toBe(0);
		expect(reused.url).toBe(ownerServer.url);
		await reused.close();
		// The reused close must not have closed the owner server or removed the registry.
		expect(await readRegistryRecord(dir, "session-test")).toEqual(expect.objectContaining({ url: ownerServer.url }));
		await ownerServer.close();
	});

	it("refuses to publish a non-loopback or token-less URL", async () => {
		let attempt = 0;
		const openWeb = async (): Promise<BacklogWeb> => {
			attempt++;
			return {
				url: attempt === 1 ? "http://example.com/#access=token" : "http://127.0.0.1:12345/",
				close: async () => undefined,
			};
		};
		const helper = sharedWorkspaceWeb(openWeb);
		await expect(helper({} as never, backlog, () => undefined)).rejects.toThrow("invalid local URL");
		await expect(helper({} as never, backlog, () => undefined)).rejects.toThrow("invalid local URL");
	});

	it("creates an owner-only registry directory", async () => {
		const openWeb = async (): Promise<BacklogWeb> => ({
			url: "http://127.0.0.1:12345/#access=owner-only",
			close: async () => undefined,
		});
		const helper = sharedWorkspaceWeb(openWeb);
		const web = await helper({} as never, backlog, () => undefined);
		try {
			const { dir: registryDir } = registryPathsForTest(dir, "session-test");
			expect(fs.statSync(registryDir).mode & 0o777).toBe(0o700);
		} finally {
			await web.close();
		}
	});

	it("shares a workspace server across processes", async () => {
		const outputFile = path.join(dir, "child.json");
		const child = fork(childScript, [], {
			execArgv: ["--experimental-strip-types"],
			env: { ...process.env, SHARED_WEB_OUTPUT: outputFile },
			stdio: ["inherit", "inherit", "inherit", "ipc"],
		});
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("child did not become ready")), 5000);
				child.once("message", () => {
					clearTimeout(timer);
					resolve();
				});
				child.once("error", reject);
				child.once("exit", (code) => {
					if (code !== 0) reject(new Error(`child exited with ${code}`));
				});
			});
			const { url, pid } = JSON.parse(fs.readFileSync(outputFile, "utf8")) as { url: string; pid: number };
			expect(typeof url).toBe("string");
			expect(pid).not.toBe(process.pid);

			// Seed the registry with the child's server and call the helper: it must reuse the URL.
			const { entry } = registryPathsForTest(dir, "session-test");
			fs.mkdirSync(path.dirname(entry), { recursive: true });
			fs.writeFileSync(entry, JSON.stringify({ url, pid }));

			let started = false;
			const openWeb = async (): Promise<BacklogWeb> => {
				started = true;
				return fakeWorkspaceServer("should-not-start");
			};
			const helper = sharedWorkspaceWeb(openWeb);
			const reused = await helper({} as never, backlog, () => undefined);
			expect(started).toBe(false);
			expect(reused.url).toBe(url);
			await reused.close();
			// The reused close must not have contacted the child.
			expect(fs.existsSync(outputFile)).toBe(true);
		} finally {
			child.send("close");
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => resolve(), 2000);
				child.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
			if (!child.killed) child.kill("SIGKILL");
		}
	});
});

describe("sharedWorkspaceWeb with startWorkspaceWeb", () => {
	let dir: string;
	let db: ReturnType<typeof openAgentDb>;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-web-real-"));
		db = openAgentDb(path.join(dir, "db"));
	});

	afterEach(() => {
		db.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("shares a real workspace web server within one process", async () => {
		const store = fixtureBacklog(() => db, "repo");
		const actor = { id: "parent" };
		const backlog: Backlog = {
			store,
			actor,
			session: "session-test",
			repoName: "repo",
			repoRoot: dir,
		};
		const openWeb = async (_ctx: unknown, b: Backlog, changed: () => void) => startWorkspaceWeb(b, changed);
		const helper = sharedWorkspaceWeb(openWeb);
		const first = await helper({} as never, backlog, () => undefined);
		const second = await helper({} as never, backlog, () => undefined);
		expect(second.url).toBe(first.url);

		const token = new URL(first.url).hash.slice(8);
		const probe = await fetch(new URL("/api/backlogs", first.url).href, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(probe.status).toBe(200);

		await first.close();
		// A second close is a no-op because only the first invocation owned the server.
		await second.close();
		expect(await readRegistryRecord(dir, "session-test")).toBeUndefined();
	});

	it("validates a server this process owns from local state, without a loopback request", async () => {
		const store = fixtureBacklog(() => db, "repo");
		const backlog: Backlog = { store, actor: { id: "parent" }, session: "local", repoName: "repo", repoRoot: dir };
		const helper = sharedWorkspaceWeb(async (_ctx, current, changed) => startWorkspaceWeb(current, changed));
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		try {
			const first = await helper({} as never, backlog, () => undefined);
			const reused = await helper({} as never, backlog, () => undefined);
			expect(reused.url).toBe(first.url);
			expect(await first.validate?.()).toBe(true);
			expect(await reused.validate?.()).toBe(true);
			expect(fetchSpy).not.toHaveBeenCalled();
			await first.close();
			expect(await reused.validate?.()).toBe(false);
			expect(await first.validate?.()).toBe(false);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("keeps each session's live workspace separate while sharing repository entities", async () => {
		const store = fixtureBacklog(() => db, "repo");
		const backlog: Backlog = { store, actor: { id: "first" }, session: "first", repoName: "repo", repoRoot: dir };
		const helper = sharedWorkspaceWeb(async (_ctx, current, changed) => startWorkspaceWeb(current, changed));
		const first = await helper({} as never, backlog, () => undefined);
		const second = await helper({} as never, { ...backlog, session: "second" }, () => undefined);
		try {
			expect(second.url).not.toBe(first.url);
			store.add({ title: "Shared task", createdBy: "user" });
			for (const web of [first, second]) {
				const url = new URL(web.url);
				const response = await fetch(new URL("/api/backlogs", url), {
					headers: { Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("access")}` },
				});
				expect(await response.json()).toMatchObject({ items: [{ title: "Shared task" }] });
			}
		} finally {
			await second.close();
			await first.close();
		}
	});
});
