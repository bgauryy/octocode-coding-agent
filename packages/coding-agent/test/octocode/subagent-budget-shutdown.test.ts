import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import type * as Descendants from "../../src/octocode/shared/process-descendants.ts";
import { MAX_REQUESTS_ENV } from "../../src/octocode/subagents/budget.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

const capture = vi.hoisted(() => ({
	entered: Promise.withResolvers<void>(),
	release: Promise.withResolvers<void>(),
}));
vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));
vi.mock("../../src/octocode/shared/process-descendants.ts", async (original) => {
	const real = await original<typeof Descendants>();
	return {
		...real,
		descendantRows: async (pid: number | undefined) => {
			capture.entered.resolve();
			await capture.release.promise;
			return real.descendantRows(pid);
		},
	};
});

it("stops model work at the budget before waiting for descendant inspection", async () => {
	const savedEnv = { ...process.env };
	const savedArgv = process.argv[1];
	const root = tmp("octocode-budget-shutdown-");
	const log = path.join(root, "child.log");
	const fixture = path.join(root, "child.cjs");
	fs.copyFileSync(new URL("./subagent-fake-host.cjs", import.meta.url), fixture);
	resetOctocodeEnv();
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
		OCTOCODE_FAKE_LOG: log,
		[MAX_REQUESTS_ENV]: "3",
	});
	process.argv[1] = fixture;
	const progress: number[] = [];
	const run = runSubagent({
		task: "budget loop 40",
		args: [],
		cwd: root,
		identity: { id: "budget-snapshot-barrier" },
		onProgress: (update) => {
			if (update.requests !== undefined) progress.push(update.requests);
		},
	});
	try {
		await capture.entered.promise;
		// Inspection is held: a responsive child must already have received abort, with no extra requests.
		await vi.waitFor(() => expect(fs.readFileSync(log, "utf8").split("\n")).toContain("abort"), {
			timeout: 300,
			interval: 10,
		});
		expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
		capture.release.resolve();
		const result = await run;
		expect(result.budget).toEqual({ requests: 5, limit: 3 });
		expect(result.usage.totalTokens).toBe(720);
		expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
	} finally {
		capture.release.resolve();
		await run.catch(() => undefined);
		process.argv[1] = savedArgv!;
		process.env = savedEnv;
	}
}, 15_000);
