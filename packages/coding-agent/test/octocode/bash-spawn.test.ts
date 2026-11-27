import type * as importedModule1 from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { tmp } from "./helpers.ts";

vi.mock("node:child_process", async (actual) => ({
	...(await actual<typeof importedModule1>()),
	spawn: () => {
		const child = Object.assign(new EventEmitter(), { pid: undefined, unref: () => undefined, stdin: null });
		process.nextTick(() => child.emit("error", Object.assign(new Error("spawn /bin/sh EAGAIN"), { code: "EAGAIN" })));
		return child;
	},
}));
// The setup file already loaded these modules (through the MCP host ports); reload them under the mocks above.
vi.resetModules();
const { BashJobs } = await import("../../src/octocode/files/bash-jobs.ts");

describe("background bash spawn failure", () => {
	it("refuses with the cause instead of reporting a job with no pid (which would suggest kill -- -0), and leaves no log", async () => {
		const dir = tmp();
		const jobs = new BashJobs(dir);
		await expect(jobs.start("echo hi", tmp(), undefined, () => undefined)).rejects.toThrow(
			/Could not start a background shell \(.+\): spawn \/bin\/sh EAGAIN\. Nothing is running\./,
		);
		expect(jobs.jobs.size).toBe(0);
		expect(fs.readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith(".log"))).toEqual([]);
	});
});
