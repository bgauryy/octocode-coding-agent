import type * as WorkerThreads from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeSegment } from "../../src/octocode/history/archive.ts";
import { closeArchiveIndex } from "../../src/octocode/history/index/client.ts";
import { rankHistory } from "../../src/octocode/history/rank.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { tmp } from "./helpers.ts";

// The boundary under test: Node cannot load the worker's file (a bundle without it, a file being rewritten).
vi.mock("node:worker_threads", async (original) => {
	const real = await original<typeof WorkerThreads>();
	class MissingWorker extends real.Worker {
		constructor(_entry: URL, options: WorkerThreads.WorkerOptions) {
			super(new URL("./no-such-archive-index-worker.mjs", import.meta.url), options);
		}
	}
	return { ...real, Worker: MissingWorker };
});

let saved: string | undefined;
beforeEach(() => {
	saved = process.env.OCTOCODE_HOME;
	process.env.OCTOCODE_HOME = tmp();
});
afterEach(async () => {
	await closeArchiveIndex();
	setCurrentSession(undefined);
	if (saved === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = saved;
});

it("ranks on the main thread when the worker cannot load, and says so", async () => {
	setCurrentSession("s1");
	const { file } = writeSegment(
		{
			session: "s1",
			entry: "e-1",
			tokensBefore: 1,
			method: "standalone",
			tldr: "walrus notes",
			topics: [],
			readFiles: [],
			modifiedFiles: [],
			messages: 1,
		},
		"### user\nthe walrus registry moved\n\n### assistant\nnothing else here",
	);
	const files = [{ file, session: { id: "s1", relation: "same repository" as const }, label: "walrus notes" }];

	const ranked = await rankHistory(files, "walrus registry");

	expect(ranked.hits).toBeGreaterThan(0);
	expect(ranked.text).toContain("walrus registry moved");
	expect(ranked.degraded).toMatch(/could not load/);
});
