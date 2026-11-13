import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceStateDir, WORKSPACE_STATE } from "../../src/storage/workspace.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

describe("workspace state folders", () => {
	it("flush their parent once per call that creates folders, and not at all when they exist", () => {
		const cwd = tmp("ws-fsync-");
		fs.mkdirSync(path.join(cwd, ".git"));
		// The workspace marker and its folders first; flushes there are the marker's own.
		ensureWorkspaceStateDir(cwd, "sessions");
		const fsync = vi.spyOn(fs, "fsyncSync");

		const created = ensureWorkspaceStateDir(cwd, path.join("sessions", "s1", "output"));
		expect(created).toBe(path.join(fs.realpathSync(cwd), WORKSPACE_STATE, "sessions", "s1", "output"));
		expect(fs.statSync(created).isDirectory()).toBe(true);
		expect(fsync).toHaveBeenCalledTimes(1);

		fsync.mockClear();
		ensureWorkspaceStateDir(cwd, path.join("sessions", "s1", "output"));
		expect(fsync).not.toHaveBeenCalled();
	});
});
