import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const registry = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/octocode/api/registry.ts");
const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs `body` in a fresh Node process with the registry as `r` and `node:fs` as `fs`; `dir` is a private API folder. */
function run(body: string): { dir: string; status: number | null; stderr: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-exit-"));
	made.push(dir);
	const script = `const fs = (await import("node:fs")).default; const r = await import(${JSON.stringify(registry)}); const dir = ${JSON.stringify(dir)}; ${body}`;
	const child = spawnSync(process.execPath, ["--conditions=source", "--input-type=module", "-e", script], {
		encoding: "utf8",
	});
	return { dir, status: child.status, stderr: child.stderr };
}

const left = (dir: string): string[] => fs.readdirSync(dir, { recursive: true }).map(String).sort();

describe.runIf(process.platform !== "win32")("an API record at exit", () => {
	it("is removed with its socket when the process exits without stopping the API", () => {
		const result = run(`
			const socket = dir + "/oc-abc123.sock";
			fs.writeFileSync(socket, "");
			r.writeRecord(dir, { id: "oc-abc123", pid: process.pid, cwd: dir, startedAt: Date.now(), protocol: 1, socket });
			process.exit(7);
		`);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(7);
		expect(left(result.dir)).toEqual(["instances"]);
	});

	it("leaves another process's record, and a record this process removed itself stays removed", () => {
		const result = run(`
			r.writeRecord(dir, { id: "oc-000001", pid: 1, cwd: dir, startedAt: Date.now(), protocol: 1 });
			r.writeRecord(dir, { id: "oc-000002", pid: process.pid, cwd: dir, startedAt: Date.now(), protocol: 1 });
			r.removeRecord(dir, "oc-000002");
			console.error(process.listenerCount("exit") > 1 ? "more than one exit listener" : "");
			process.exit(0);
		`);
		expect(result.stderr.trim()).toBe("");
		expect(left(result.dir)).toEqual(["instances", "instances/oc-000001.json"]);
	});
});
