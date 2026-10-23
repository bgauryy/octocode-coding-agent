import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type * as RoleModule from "../../src/octocode/instructions/role.ts";
import { writeRolePrompt } from "../../src/octocode/instructions/role.ts";
import { runSubagent, subagentProcessEnv } from "../../src/octocode/subagents/process.ts";
import { prepareChildResourceFiles } from "../../src/octocode/subagents/process/handoff-files.ts";
import { tmp } from "./helpers.ts";
vi.mock("../../src/octocode/instructions/role.ts", async (original) => ({
	...(await original<typeof RoleModule>()),
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
it("cleans a partially written MCP handoff and preserves its write error", () => {
	const scratch = tmp();
	const error = new Error("MCP write failed");
	const write = fs.writeFileSync;
	vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...args) => {
		if (typeof file === "number") {
			write(file, "partial");
			throw error;
		}
		return write(file, ...args);
	});
	expect(() =>
		prepareChildResourceFiles({ id: "cleanup", scratch, mcpServers: { fixture: { command: "echo" } } }),
	).toThrow(error);
	expect(fs.readdirSync(scratch)).toEqual([]);
});
it("does not remove an MCP handoff it failed to create", () => {
	const scratch = tmp();
	const open = fs.openSync;
	let collidedFile: string | undefined;
	vi.spyOn(fs, "openSync").mockImplementation((file, ...args) => {
		if (typeof file === "string" && path.basename(file).startsWith("mcp-servers-")) {
			collidedFile = file;
			writeCollision(file);
			throw Object.assign(new Error("collision"), { code: "EEXIST" });
		}
		return open(file, ...args);
	});
	function writeCollision(file: string) {
		const fd = open(file, "wx", 0o600);
		try {
			fs.writeFileSync(fd, "pre-existing");
		} finally {
			fs.closeSync(fd);
		}
	}
	expect(() =>
		prepareChildResourceFiles({ id: "cleanup", scratch, mcpServers: { fixture: { command: "echo" } } }),
	).toThrow("collision");
	expect(collidedFile).toBeDefined();
	expect(fs.readFileSync(collidedFile!, "utf8")).toBe("pre-existing");
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
