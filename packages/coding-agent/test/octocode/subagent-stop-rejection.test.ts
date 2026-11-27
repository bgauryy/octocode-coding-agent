import fs from "node:fs";
import path from "node:path";
import type * as Config from "../../src/config.ts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stopTree } from "../../src/octocode/shared/process.ts";
import type * as ProcessModule from "../../src/octocode/shared/process.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import { tmp } from "./helpers.ts";

// The tree stop itself fails (a process table that cannot be read): the run must still conclude.
vi.mock("../../src/octocode/shared/process.ts", async (original) => ({
	...(await original<typeof ProcessModule>()),
	stopTree: vi.fn(async () => {
		throw new Error("process table unreadable");
	}),
}));

// The child is the scripted stand-in, started the way the real one is.
vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof Config>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedHome = process.env.OCTOCODE_HOME;

beforeAll(() => {
	const root = tmp("octocode-stop-rejection-");
	process.env.OCTOCODE_HOME = path.join(root, "home");
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	if (savedHome === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = savedHome;
});

describe.skipIf(process.platform === "win32")("a tree stop that rejects", () => {
	it("still concludes the run, so its slot is released", async () => {
		const controller = new AbortController();
		let stamps = 0;
		let running!: () => void;
		const runs = new Promise<void>((resolve) => {
			running = resolve;
		});
		const run = runSubagent({
			task: "abortable",
			args: [],
			cwd: tmp(),
			identity: { id: "a-reject" },
			signal: controller.signal,
			onProgress: () => undefined,
			// `output` is stamped once when the task is sent, then at each model event the child prints: `agent_start` first.
			host: {
				permission: { allows: () => false, relayedAllow: vi.fn(), adopt: vi.fn(), relayNote: vi.fn() },
				output: () => {
					if (++stamps === 2) running();
				},
			},
		});
		const settled = run.then(
			() => "resolved",
			(error: Error) => error.message,
		);
		// The stop is of a child whose run started, not of one still loading.
		await runs;
		controller.abort();
		await expect(settled).resolves.toContain("cancelled");
		expect(stopTree).toHaveBeenCalled();
	}, 20_000);
});
