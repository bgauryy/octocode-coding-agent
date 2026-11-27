import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getNativeSkillsDir } from "../../src/config.ts";

describe("debugging skill Node metrics preload", () => {
	let root: string;
	const preload = path.join(getNativeSkillsDir(), "octocode-debugging/scripts/node-metrics.mjs");
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "node-metrics-"));
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
	const run = (source: string, interval = "20") =>
		spawnSync(process.execPath, ["--expose-gc", "--import", preload, "--input-type=module", "-e", source], {
			cwd: root,
			env: { ...process.env, NODE_OPTIONS: "", OCTOCODE_PROFILE_DIR: root, OCTOCODE_PROFILE_INTERVAL_MS: interval },
			encoding: "utf8",
			timeout: 10_000,
		});
	const records = () => {
		const files = fs.readdirSync(root).filter((file) => file.endsWith(".metrics.jsonl"));
		expect(files).toHaveLength(1);
		return fs
			.readFileSync(path.join(root, files[0]), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	};

	it("records CPU, memory, resource counters, GC and loop timing without polluting stdout", () => {
		const result = run(`
			await new Promise(resolve => setTimeout(resolve, 40));
			globalThis.keep = Array.from({length: 50000}, (_, i) => ({i, value: String(i)}));
			global.gc();
			const end = performance.now() + 60;
			while (performance.now() < end) Math.sqrt(Math.random());
			await new Promise(resolve => setTimeout(resolve, 60));
			console.log('application output');
		`);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("application output\n");
		const rows = records();
		expect(rows[0]).toMatchObject({ event: "start", node: process.version, thread: "main" });
		expect(rows.filter((row) => row.event === "sample").length).toBeGreaterThan(1);
		const final = rows.at(-1);
		expect(final).toMatchObject({ event: "exit", exitCode: 0 });
		expect(final.elapsedMs).toBeGreaterThan(120);
		expect(final.cpuMs.user).toBeGreaterThan(0);
		expect(final.memoryBytes.rss).toBeGreaterThan(0);
		expect(final.memoryBytes.heapUsed).toBeGreaterThan(0);
		expect(final.resources.fsRead).toBeGreaterThanOrEqual(0);
		expect(final.resources.maxRSS).toBeGreaterThan(0);
		expect(final.gc.count).toBeGreaterThan(0);
		expect(final.eventLoop.delayMs.max).toBeGreaterThan(30);
		expect(final.eventLoop.utilization).toBeGreaterThan(0);
	});

	it("does not keep a naturally completed application alive", () => {
		const result = run("console.log('done')", "60000");
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("done\n");
		expect(records().at(-1)).toMatchObject({ event: "exit", exitCode: 0 });
	});

	it("preserves explicit exit status", () => {
		const result = run("process.exit(7)", "60000");
		expect(result.status).toBe(7);
		const rows = records();
		expect(rows.map((row) => row.event)).toEqual(["start", "exit"]);
		expect(rows.at(-1)).toMatchObject({ exitCode: 7, eventLoop: { delayMs: null } });
	});

	it("rejects invalid sampling intervals rather than silently changing the capture", () => {
		const result = run("console.log('must not run')", "0");
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("OCTOCODE_PROFILE_INTERVAL_MS");
		expect(result.stdout).toBe("");
	});

	it("does not preload duplicate samplers in worker threads", () => {
		const result = run(`
			const { Worker } = await import('node:worker_threads');
			await new Promise((resolve, reject) => {
				const worker = new Worker('setTimeout(() => {}, 30)', { eval: true });
				worker.on('error', reject);
				worker.on('exit', resolve);
			});
		`);
		expect(result.status, result.stderr).toBe(0);
		expect(records().at(-1).event).toBe("exit");
	});
});
