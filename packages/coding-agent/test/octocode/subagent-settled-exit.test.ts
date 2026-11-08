import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import type * as LivenessModule from "../../src/octocode/subagents/liveness.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import { tmp } from "./helpers.ts";

// The real deadline is 10 s; the behavior under test is that it, not the child's busy deadline, ends the wait.
vi.mock("../../src/octocode/subagents/liveness.ts", async (original) => ({
	...(await original<typeof LivenessModule>()),
	SETTLED_EXIT_MS: 400,
}));

// The child is the scripted stand-in on argv[1], not the real CLI.
vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedHome = process.env.OCTOCODE_HOME;

beforeAll(() => {
	const root = tmp("octocode-settled-exit-");
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

describe.skipIf(process.platform === "win32")(
	"a child that settled with its report but keeps its process alive",
	() => {
		it("delivers the report within the short exit deadline, as a success, long before its busy deadline", async () => {
			const started = Date.now();
			// The busy deadline would be 25+ minutes: the run must not wait for it.
			const outcome = await runSubagent(
				"settled but alive",
				[],
				tmp(),
				undefined,
				{ id: "a-settled-alive" },
				undefined,
				() => undefined,
				undefined,
				{ idleMs: 10 * 60_000, busyMs: 15 * 60_000 },
			);
			expect(outcome.text).toContain("FINAL REPORT");
			expect(outcome.error).toBeUndefined();
			expect(Date.now() - started).toBeLessThan(15_000);
		}, 30_000);
	},
);
