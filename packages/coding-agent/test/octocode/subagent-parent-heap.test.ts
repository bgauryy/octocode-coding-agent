import fs from "node:fs";
import { PARENT_HEAP_FILE_ENV } from "@octocodeai/octocode-common/env";
import { expect, it } from "vitest";
import { sessionHeap } from "../../src/octocode/shared/session-heap.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import {
	prepareChildResourceFiles,
	removeChildResourceFiles,
} from "../../src/octocode/subagents/process/handoff-files.ts";
import { tmp } from "./helpers.ts";

const handles = [{ handle: "file:0123456789ab", path: "/work/a.ts" }];

it("hands the parent's handles to the child as an owner-only file named by an env var, removed with the run", () => {
	const scratch = tmp();
	const files = prepareChildResourceFiles({ id: "heap", scratch, heapHandles: handles });
	const file = files.parentHeapFile!;
	expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(handles);
	expect(fs.statSync(file).mode & 0o077).toBe(0);
	const env = subagentProcessEnv(undefined, {}, { id: "heap" }, undefined, undefined, undefined, undefined, file);
	expect(env[PARENT_HEAP_FILE_ENV]).toBe(file);
	// The child reads it as a read-only parent view; its own index starts empty.
	const heap = sessionHeap({}, env);
	expect(heap?.parent?.resolve("file:0123456789ab")).toMatchObject({ status: "expired" });
	expect(heap?.index.size).toBe(0);
	removeChildResourceFiles(files);
	expect(fs.existsSync(file)).toBe(false);
});

it("writes no file when the parent holds no handles, and a parent's own variable never reaches a grandchild", () => {
	expect(prepareChildResourceFiles({ id: "heap", scratch: tmp(), heapHandles: [] }).parentHeapFile).toBeUndefined();
	const env = subagentProcessEnv(undefined, { [PARENT_HEAP_FILE_ENV]: "/stale" }, { id: "heap" });
	expect(env[PARENT_HEAP_FILE_ENV]).toBeUndefined();
});
