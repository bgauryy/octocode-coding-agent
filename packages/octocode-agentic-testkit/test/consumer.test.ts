// Runs `yarn check:consumer`: a project outside the repository imports the built package by name, typechecks against
// its `dist` types and runs its tests with `testkitConfig`. Skipped, with the reason, when `dist` is missing or stale.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/check-consumer.mjs");
const check = (...args: string[]) =>
	spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 240_000 });

it("a project outside the repository consumes the built package by name", { timeout: 240_000 }, (ctx) => {
	const status = check("--dist-status");
	expect(status.status, status.stderr).toBe(0);
	const problem = status.stdout.trim();
	if (problem !== "fresh") return ctx.skip(problem);
	const run = check();
	expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
	expect(run.stdout).toMatch(
		/^consumer ok on Node [\d.]+ with Version [\d.]+: \d+ subpaths load on plain Node; tsc clean .*; vitest \d+ passed/,
	);
});
