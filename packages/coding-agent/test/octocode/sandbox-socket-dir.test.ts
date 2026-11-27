import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	reapOrphanedSocketDirs,
	SOCKET_ROOT_ENV,
	withSocketFriendlyTempDir,
} from "../../src/octocode/permission/sandbox/socket-dir.ts";

/** A pid past the system's range: never running. */
const DEAD = 999_999_999;
const made: string[] = [];
const saved = { TMPDIR: process.env.TMPDIR, root: process.env[SOCKET_ROOT_ENV] };

afterEach(() => {
	for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of [
		["TMPDIR", saved.TMPDIR],
		[SOCKET_ROOT_ENV, saved.root],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function folder(parent: string, name: string, sockets: number[]): string {
	const dir = path.join(parent, name);
	fs.mkdirSync(dir, { recursive: true });
	for (const pid of sockets) fs.writeFileSync(path.join(dir, `srt-mux-${pid}-0.sock`), "");
	return dir;
}

const shortRoot = () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "sb-test-")));
	made.push(dir);
	return dir;
};

describe.skipIf(process.platform === "win32")("sandbox socket folders", () => {
	it("reaps only folders whose every socket owner is gone", () => {
		const root = shortRoot();
		const dead = folder(root, "octocode-sb-dead", [DEAD]);
		const live = folder(root, "octocode-sb-live", [process.pid]);
		const starting = folder(root, "octocode-sb-starting", []);
		const parentDead = folder(root, "octocode-sb-parent", [DEAD]);
		folder(parentDead, "octocode-sb-child", [process.pid]);
		const deadTree = folder(root, "octocode-sb-tree", [DEAD]);
		folder(deadTree, "octocode-sb-child", [DEAD]);
		const foreign = folder(root, "other-dead", [DEAD]);

		expect(reapOrphanedSocketDirs(root).sort()).toEqual([dead, deadTree].sort());
		for (const kept of [live, starting, parentDead, foreign]) expect(fs.existsSync(kept)).toBe(true);
	});

	it("makes a direct child's folder inside its parent's, so the parent's exit removes it, and exports its own", async () => {
		const parent = folder(shortRoot(), "octocode-sb-parent", []);
		const longTmp = path.join(shortRoot(), "x".repeat(100));
		fs.mkdirSync(longTmp);
		process.env.TMPDIR = longTmp;
		process.env[SOCKET_ROOT_ENV] = `${process.ppid}:${parent}`;

		const during = await withSocketFriendlyTempDir(async () => os.tmpdir());
		expect(path.dirname(during)).toBe(parent);
		expect(process.env.TMPDIR).toBe(longTmp);
		expect(process.env[SOCKET_ROOT_ENV]).toBe(`${process.pid}:${during}`);
	});

	it("ignores a folder exported by a process that is not its parent", async () => {
		const foreign = folder(shortRoot(), "octocode-sb-foreign", []);
		const longTmp = path.join(shortRoot(), "x".repeat(100));
		fs.mkdirSync(longTmp);
		process.env.TMPDIR = longTmp;
		process.env[SOCKET_ROOT_ENV] = `${process.pid}:${foreign}`;

		const during = await withSocketFriendlyTempDir(async () => os.tmpdir());
		made.push(during);
		expect(path.dirname(during)).toBe("/tmp");
		expect(path.basename(during)).toMatch(/^octocode-sb-/);
	});
});
