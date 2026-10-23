import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeRolePrompt } from "../../src/octocode/instructions/role.ts";
import { runSubagent, subagentProcessEnv } from "../../src/octocode/subagents/process.ts";
import { tmp } from "./helpers.ts";
vi.mock("../../src/octocode/instructions/role.ts", async (original) => ({
	...(await original<typeof import("../../src/octocode/instructions/role.ts")>()),
	writeRolePrompt: vi.fn(),
}));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
const empty = { version: 1 as const, resources: [], explicitSkills: [] };
it("cleans snapshot when later role preparation throws", async () => {
	const scratch = tmp();
	const error = new Error("role failed");
	vi.mocked(writeRolePrompt).mockImplementation(() => {
		expect(fs.readdirSync(scratch).some((name) => name.startsWith("skills-"))).toBe(true);
		throw error;
	});
	await expect(
		runSubagent(
			"task",
			[],
			scratch,
			{ prompt: "role" } as never,
			{ id: "cleanup", scratch, skillResources: empty },
			undefined,
			() => {},
		),
	).rejects.toBe(error);
	expect(fs.readdirSync(scratch)).toEqual([]);
});
it("cleans partially written snapshot and preserves its write error", async () => {
	const scratch = tmp();
	const error = new Error("write failed");
	const write = fs.writeFileSync;
	vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...args) => {
		if (typeof file === "number") {
			write(file, "partial");
			throw error;
		}
		return write(file, ...args);
	});
	await expect(
		runSubagent("task", [], scratch, undefined, { id: "cleanup", scratch, skillResources: empty }, undefined, () => {}),
	).rejects.toBe(error);
	expect(fs.readdirSync(scratch)).toEqual([]);
});
it("does not allocate a snapshot for a pre-cancelled child and clears inherited transport", async () => {
	const scratch = tmp();
	await expect(
		runSubagent(
			"task",
			[],
			scratch,
			undefined,
			{ id: "cleanup", scratch, skillResources: empty },
			AbortSignal.abort(),
			() => {},
		),
	).rejects.toThrow("cancelled");
	expect(fs.readdirSync(scratch)).toEqual([]);
	expect(
		subagentProcessEnv(undefined, { OCTOCODE_SKILL_SNAPSHOT_FILE: path.join(scratch, "stale") }, { id: "cleanup" }),
	).not.toHaveProperty("OCTOCODE_SKILL_SNAPSHOT_FILE");
});
