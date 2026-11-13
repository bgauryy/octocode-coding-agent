import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_PROTOCOL_VERSION, type DaemonRecord } from "@octocodeai/octocode-contracts/daemon";
import { readDaemonRecord, writeDaemonRecord } from "../../src/octocode/web-daemon/records.ts";
import { listInstances, writeRecord } from "../../src/octocode/api/registry.ts";

const record = (port: number, padding: number): DaemonRecord => ({
	pid: process.pid,
	port,
	url: `http://127.0.0.1:${port}/#access=${"t".repeat(padding)}`,
	protocolVersion: DAEMON_PROTOCOL_VERSION,
	build: "test",
	startedAt: 1,
	nonce: "nonce",
});

/** Reads `file` in a tight loop on another thread until told to stop; counts reads that exist but do not parse. */
function startReader(file: string): { stop: () => Promise<{ reads: number; torn: number }> } {
	const flag = new Int32Array(new SharedArrayBuffer(4));
	const worker = new Worker(
		`const { workerData, parentPort } = require("node:worker_threads");
		const fs = require("node:fs");
		const flag = workerData.flag;
		let reads = 0, torn = 0;
		while (Atomics.load(flag, 0) === 0) {
			let text;
			try { text = fs.readFileSync(workerData.file, "utf8"); } catch { continue; }
			reads++;
			try { JSON.parse(text); } catch { torn++; }
		}
		parentPort.postMessage({ reads, torn });`,
		{ eval: true, workerData: { file, flag } },
	);
	const result = new Promise<{ reads: number; torn: number }>((resolve, reject) => {
		worker.once("message", resolve);
		worker.once("error", reject);
	});
	return {
		stop: async () => {
			Atomics.store(flag, 0, 1);
			const counts = await result;
			await worker.terminate();
			return counts;
		},
	};
}

let root: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-discovery-"));
});
afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("discovery records", () => {
	it("never show a reader a partial daemon record, and are written without flushing to disk", async () => {
		const file = path.join(root, "run", "daemon.json");
		writeDaemonRecord(file, record(4000, 1));
		const fsync = vi.spyOn(fs, "fsyncSync");
		const reader = startReader(file);
		for (let i = 0; i < 400; i++) writeDaemonRecord(file, record(4000 + i, (i * 997) % 20_000));
		const { reads, torn } = await reader.stop();
		expect(reads).toBeGreaterThan(0);
		expect(torn).toBe(0);
		expect(JSON.parse(fs.readFileSync(file, "utf8")).port).toBe(4399);
		writeDaemonRecord(file, record(4500, 1));
		expect(readDaemonRecord(file)?.port).toBe(4500);
		expect(fsync).not.toHaveBeenCalled();
		expect(fs.readdirSync(path.dirname(file))).toEqual(["daemon.json"]);
	});

	it("never show a reader a partial instance record, and are written without flushing to disk", async () => {
		const instance = (n: number) => ({
			id: "oc-abc123",
			pid: process.pid,
			cwd: `/work/${"x".repeat((n * 991) % 20_000)}`,
			startedAt: n,
			protocol: 1,
		});
		writeRecord(root, instance(0));
		const fsync = vi.spyOn(fs, "fsyncSync");
		const reader = startReader(path.join(root, "instances", "oc-abc123.json"));
		for (let i = 1; i <= 400; i++) writeRecord(root, instance(i));
		const { reads, torn } = await reader.stop();
		expect(reads).toBeGreaterThan(0);
		expect(torn).toBe(0);
		expect(listInstances(root, false).map((entry) => entry.startedAt)).toEqual([400]);
		expect(fsync).not.toHaveBeenCalled();
	});
});
