import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const runnerPath = "test/octocode/scripts/live-acp-reliability.mjs";

it.skipIf(process.platform === "win32")(
	"runs the source native agent, API CLI and ACP fixture lifecycle without cloud calls or leftover processes",
	() => {
		const root = mkdtempSync(join(tmpdir(), "acp-runner-smoke-"));
		try {
			const result = spawnSync(process.execPath, [join(packageRoot, runnerPath), "--fixture", "--out", root], {
				encoding: "utf8",
				timeout: 120_000,
			});
			expect(result.error, result.stderr).toBeUndefined();
			expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
			const runs = readdirSync(root);
			expect(runs).toHaveLength(1);
			const report = JSON.parse(readFileSync(join(root, runs[0], "results.json"), "utf8")) as {
				error?: string;
				mode: string;
				cloudPromptAttempts: number;
				runtime: { codingAgent: string; ai: string };
				hashes: Record<string, string>;
				checks: Record<string, unknown>;
				trials: { state: string; correlation: { outboundId: string; inboundId: string | null } }[];
				vendors: Record<string, unknown>[];
			};
			expect(report.error).toBeUndefined();
			expect(report.mode).toBe("fixture");
			expect(report.cloudPromptAttempts).toBe(0);
			expect(report.runtime.codingAgent).toBe(
				pathToFileURL(join(packageRoot, "src/core/agent-session/create-session.ts")).href,
			);
			expect(report.runtime.ai).toBe(pathToFileURL(join(packageRoot, "../ai/src/index.ts")).href);
			expect(report.hashes[runnerPath]).toBe(
				createHash("sha256")
					.update(readFileSync(join(packageRoot, runnerPath)))
					.digest("hex"),
			);
			expect(report.checks).toEqual({
				controllerRegisteredToolApi: true,
				noRemainingConnections: true,
				homeUnchanged: true,
				apiRecordsAfterShutdown: 0,
				liveGroupsAfterShutdown: [],
			});
			expect(report.trials).toHaveLength(18);
			expect(report.trials.filter((trial) => trial.state === "completed")).toHaveLength(16);
			expect(report.trials.filter((trial) => trial.state === "uncertain")).toHaveLength(2);
			for (const trial of report.trials) {
				expect(trial.correlation.outboundId).toBeTruthy();
				expect(Boolean(trial.correlation.inboundId)).toBe(trial.state === "completed");
			}
			expect(report.vendors).toHaveLength(2);
			for (const vendor of report.vendors) {
				expect(vendor).toMatchObject({
					mainSuccessfulPrompts: 5,
					completed: true,
					savedSessionRecovery: true,
					sameConnectionRefusal: { execution: "not-sent" },
					crash: { explicitUncertain: true, noReplay: true },
				});
				expect(vendor.overlapMs).toBeGreaterThan(0);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	125_000,
);
