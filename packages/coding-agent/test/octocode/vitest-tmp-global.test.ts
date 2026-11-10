import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import setup from "../../../../vitest.tmp.global.ts";

const KEYS = ["TMPDIR", "TEMP", "TMP"] as const;

describe("the test runs' temporary root", () => {
	const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
	let parent: string;

	beforeEach(() => {
		parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vt-parent-"));
		process.env.TMPDIR = parent;
	});
	afterEach(() => {
		for (const key of KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		fs.rmSync(parent, { recursive: true, force: true });
	});

	function root(name: string, pid: number): string {
		const dir = path.join(parent, name);
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, ".owner-pid"), String(pid));
		return dir;
	}

	it("sweeps a root whose owner is gone, keeps a live owner's and an unrelated folder, and removes its own at teardown", () => {
		const dead = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout);
		const stale = root("vt-stale", dead);
		const live = root("vt-live", process.pid);
		const unrelated = path.join(parent, "other");
		fs.mkdirSync(unrelated);

		const teardown = setup();
		const own = process.env.TMPDIR as string;
		expect(path.dirname(own)).toBe(parent);
		expect(own.startsWith(path.join(parent, "vt-"))).toBe(true);
		expect(fs.existsSync(stale)).toBe(false);
		expect(fs.existsSync(live)).toBe(true);
		expect(fs.existsSync(unrelated)).toBe(true);
		expect(fs.readFileSync(path.join(own, ".owner-pid"), "utf8")).toBe(String(process.pid));

		teardown();
		expect(fs.existsSync(own)).toBe(false);
		expect(fs.existsSync(live)).toBe(true);
	});
});
