import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Backlog, BacklogWeb } from "../../src/octocode/backlog/context.ts";
import { sharedWorkspaceWeb } from "../../src/octocode/backlog/shared-web.ts";
import { acquireRegistryLock } from "../../src/octocode/backlog/shared-web-lock.ts";
import { readRecord, registryPaths } from "../../src/octocode/backlog/shared-web-registry.ts";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-web-failures-"));
	env = { ...process.env, OCTOCODE_AGENT_DB: path.join(dir, "state", "octocode.db") };
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const backlog = (): Backlog => ({
	store: { repo: "repo" } as Backlog["store"],
	actor: { id: "test" },
	session: "session-failures",
	repoName: "repo",
	repoRoot: dir,
});

const URL_A = "http://127.0.0.1:1/#access=a";

function open(close: () => Promise<void>, counter = { starts: 0 }) {
	return sharedWorkspaceWeb(async (): Promise<BacklogWeb> => {
		counter.starts++;
		return { url: URL_A, close };
	}, env);
}

describe("registry lock compromise", () => {
	it("reports a takeover and leaves the new owner's lock and owner file alone", async () => {
		const lockPath = path.join(dir, ".entry.lock");
		let lost: Error | undefined;
		const release = await acquireRegistryLock(lockPath, 1000, {
			staleMs: 2000,
			onCompromised: (error) => (lost = error),
		});
		// This process stalled; another took the stale lock over: a new lock directory and owner file.
		fs.rmdirSync(`${lockPath}.lock`);
		fs.mkdirSync(`${lockPath}.lock`);
		fs.writeFileSync(`${lockPath}.owner`, JSON.stringify({ pid: 1, pid_started: undefined }));
		const deadline = Date.now() + 5000;
		while (!lost && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
		expect(lost).toMatchObject({ code: "ECOMPROMISED" });
		expect(() => release.assertHeld()).toThrow(lost);
		await release();
		expect(fs.existsSync(`${lockPath}.lock`)).toBe(true);
		expect(JSON.parse(fs.readFileSync(`${lockPath}.owner`, "utf8"))).toEqual({ pid: 1 });
		fs.rmdirSync(`${lockPath}.lock`);
	});
});

describe("shared workspace web failure paths", () => {
	it("does not start a replacement when the registry record cannot be read", async () => {
		const { entry } = registryPaths(dir, "session-failures", env);
		// Not ENOENT and not a malformed record: the read itself fails (EISDIR here; EIO or EACCES alike).
		fs.mkdirSync(entry, { recursive: true });
		const counter = { starts: 0 };
		await expect(open(async () => undefined, counter)({} as never, backlog(), () => undefined)).rejects.toMatchObject({
			code: "EISDIR",
		});
		expect(counter.starts).toBe(0);
	});

	it("leaves the registry record alone when close cannot take the registry lock, and says so", async () => {
		const { entry, lock } = registryPaths(dir, "session-failures", env);
		let closes = 0;
		const web = await open(async () => void closes++)({} as never, backlog(), () => undefined);
		expect((await readRecord(entry))?.url).toBe(URL_A);
		// The lock cannot be taken (a stale regular file where its directory belongs fails at once).
		fs.writeFileSync(`${lock}.lock`, "");
		const old = new Date(Date.now() - 120_000);
		fs.utimesSync(`${lock}.lock`, old, old);
		await expect(web.close()).rejects.toThrow(/registry entry was left in place/);
		expect(closes).toBe(1);
		expect((await readRecord(entry))?.url).toBe(URL_A);
		// Once the lock is usable again, a retry removes the record without closing the server twice.
		fs.rmSync(`${lock}.lock`);
		await web.close();
		expect(closes).toBe(1);
		expect(await readRecord(entry)).toBeUndefined();
	});

	it("rejects when the server's close fails, keeps its record, and lets the close be retried", async () => {
		const { entry } = registryPaths(dir, "session-failures", env);
		let fail = true;
		const web = await open(async () => {
			if (fail) throw new Error("port still bound");
		})({} as never, backlog(), () => undefined);
		await expect(web.close()).rejects.toThrow("port still bound");
		expect((await readRecord(entry))?.url).toBe(URL_A);
		fail = false;
		await web.close();
		expect(await readRecord(entry)).toBeUndefined();
	});

	it("rejects when the server's close does not finish in time", async () => {
		const { entry } = registryPaths(dir, "session-failures", env);
		const web = await open(() => new Promise<void>(() => {}))({} as never, backlog(), () => undefined);
		await expect(web.close()).rejects.toThrow(/did not close within/);
		expect((await readRecord(entry))?.url).toBe(URL_A);
	}, 10_000);
});
