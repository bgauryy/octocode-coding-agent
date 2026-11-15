import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { closeSharedConnections, openDatabase, prepareSharedDatabase, sharedDatabase } from "../src/db.ts";
import { AgentDbError } from "../src/schema.ts";
import { busyTimeout, isBusy } from "../src/sqlite.ts";
import { tmp } from "./helpers.ts";

afterEach(closeSharedConnections);

function locations() {
	const dir = tmp();
	return {
		file: path.join(dir, "workspaces.db"),
		mirrorFile: path.join(dir, "transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	};
}

async function held(file: string) {
	const release = new Int32Array(new SharedArrayBuffer(4));
	const worker = new Worker(new URL("./fixtures/hold-empty.mts", import.meta.url), {
		workerData: { file, release: release.buffer },
	});
	const exited = new Promise<void>((resolve, reject) => {
		worker.once("error", reject);
		worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Lock holder exited ${code}`))));
	});
	await Promise.race([
		new Promise((resolve) => worker.once("message", resolve)),
		exited.then(() => {
			throw new Error("Holder exited before ready");
		}),
	]);
	return async () => {
		Atomics.store(release, 0, 1);
		Atomics.notify(release, 0);
		await exited;
	};
}

describe("asynchronous shared database preparation", () => {
	it.each(["coordination", "mirror"] as const)(
		"yields while the cold %s file is locked, then restores normal connection waits",
		async (kind) => {
			const files = locations();
			const release = await held(kind === "coordination" ? files.file : files.mirrorFile);
			let settled = false;
			const pending = prepareSharedDatabase(files, { mirror: kind === "mirror" }).finally(() => {
				settled = true;
			});
			try {
				await sleep(10);
				expect(settled).toBe(false);
				await release();
				const agent = await pending;
				expect(sharedDatabase(files)).toBe(agent);
				expect(busyTimeout(agent.db)).toBe(5000);
				if (kind === "mirror") expect(busyTimeout(agent.mirror.db)).toBe(5000);
				else expect(fs.existsSync(files.mirrorFile)).toBe(false);
			} finally {
				await release();
				await pending.catch(() => undefined);
			}
		},
	);

	it("keeps one shared connection for concurrent preparation and preserves lazy synchronous mirror opening", async () => {
		const files = locations();
		const [first, second] = await Promise.all([prepareSharedDatabase(files), prepareSharedDatabase(files)]);
		expect(first).toBe(second);
		expect(fs.existsSync(files.mirrorFile)).toBe(false);
		expect(busyTimeout(first.mirror.db)).toBe(5000);
		const independent = openDatabase(files);
		try {
			expect(independent).not.toBe(first);
			expect(busyTimeout(independent.db)).toBe(5000);
		} finally {
			independent.close();
		}
	});

	it("preserves the foreign-file refusal and retries neither its contents nor its cached error", async () => {
		const files = locations();
		const bytes = Buffer.from("not a database");
		fs.writeFileSync(files.file, bytes);
		const failure = await prepareSharedDatabase(files).catch((error) => error);
		expect(failure).toBeInstanceOf(AgentDbError);
		await expect(prepareSharedDatabase(files)).rejects.toBe(failure);
		expect(() => sharedDatabase(files)).toThrow(failure);
		expect(fs.readFileSync(files.file)).toEqual(bytes);
	});

	it("leaves coordination usable when optional mirror initialization refuses a foreign file", async () => {
		const files = locations();
		fs.writeFileSync(files.mirrorFile, "foreign mirror");
		await expect(prepareSharedDatabase(files, { mirror: true })).rejects.toBeInstanceOf(AgentDbError);
		expect(sharedDatabase(files).db.isOpen).toBe(true);
		expect(() => sharedDatabase(files).mirror).toThrow(AgentDbError);
		expect(fs.readFileSync(files.mirrorFile, "utf8")).toBe("foreign mirror");
	});

	it("cancels a pending open without poisoning the file for a later attempt", async () => {
		const files = locations();
		const release = await held(files.file);
		const controller = new AbortController();
		const pending = prepareSharedDatabase(files, { signal: controller.signal });
		try {
			await sleep(10);
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
			await release();
			expect((await prepareSharedDatabase(files)).db.isOpen).toBe(true);
		} finally {
			await release();
			await pending.catch(() => undefined);
		}
	});

	it("does not reopen a connection after shared cleanup cancels preparation", async () => {
		const files = locations();
		const release = await held(files.file);
		const pending = prepareSharedDatabase(files);
		try {
			await sleep(10);
			closeSharedConnections();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
			await release();
			expect((await prepareSharedDatabase(files)).db.isOpen).toBe(true);
		} finally {
			await release();
			await pending.catch(() => undefined);
		}
	});

	it("exhausts the original busy budget without blocking timers or caching a permanent refusal", async () => {
		const files = locations();
		const release = await held(files.file);
		let timerFired = false;
		const timer = setTimeout(() => {
			timerFired = true;
		}, 10);
		const start = performance.now();
		try {
			const failure = await prepareSharedDatabase(files).catch((error) => error);
			expect(timerFired).toBe(true);
			expect(isBusy(failure)).toBe(true);
			expect(performance.now() - start).toBeGreaterThanOrEqual(5000);
			await release();
			expect((await prepareSharedDatabase(files)).db.isOpen).toBe(true);
		} finally {
			clearTimeout(timer);
			await release();
		}
	});
});
