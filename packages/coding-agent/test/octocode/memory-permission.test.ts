import { registerArchiveTool } from "../../src/octocode/archive/tool.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerMemory } from "../../src/octocode/memory/register.ts";
import type { PermissionMode } from "../../src/octocode/permission/mode.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";

let root: string;
let cwd: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octo-memory-permission-"));
	cwd = path.join(root, "repo");
	fs.mkdirSync(cwd);
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", "");
});

afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

function memoryTool(mode: PermissionMode) {
	const fake = fakeHost();
	registerArchiveTool(
		fake.api,
		registerMemory(fake.api, {
			commands: new Subcommands(),
			isSubagent: false,
			permission: fakePermission(mode, { api: fake.api }),
		}),
	);
	const tool = fake.tools.get("archive");
	/** Runs the tool; `selects` answer the permission dialogs in order, and what is left of them shows how many were asked. */
	const run = (
		params: Record<string, unknown>,
		options: { hasUI?: boolean; selects?: string[]; inputs?: Array<string | undefined> } = {},
	) => {
		const ctx = Object.assign(
			fakeCtx({
				cwd,
				hasUI: options.hasUI ?? true,
				ui: { selects: options.selects ?? [], inputs: options.inputs ?? [] },
			}),
			{ isProjectTrusted: () => true },
		);
		return tool
			.execute(
				"call",
				{ goal: "Remember a preference", reason: "user requested", source: "memories", ...params },
				undefined,
				undefined,
				ctx,
			)
			.then((result: { content: Array<{ text: string }> }) => result.content[0].text);
	};
	return Object.assign(run, { entries: fake.entries });
}

describe("shared memory", () => {
	it("saves a plain workspace memory at once in every mode, with no dialog and no UI", async () => {
		for (const mode of ["manual", "workspace", "full"] as const) {
			const run = memoryTool(mode);
			const selects: string[] = [];
			expect(await run({ op: "set", title: `Project note ${mode}` }, { selects })).toMatch(/^Saved M\d+ \(workspace/);
			expect(await run({ op: "set", title: `Headless note ${mode}` }, { hasUI: false })).toMatch(/^Saved M\d+/);
			expect(run.entries.map((entry) => entry.data)).toEqual([]);
		}
	});

	it.each(["manual", "workspace"] as const)(
		"asks the user before the agent saves, changes or deletes a global or pinned memory (%s)",
		async (mode) => {
			const run = memoryTool(mode);
			for (const params of [
				{ op: "set", title: "Global rule", scope: "global" },
				{ op: "set", title: "Pinned rule", pinned: true },
			]) {
				const selects = ["Allow once"];
				expect(await run(params, { selects })).toMatch(/^Saved M\d+/);
				expect(selects).toEqual([]);
			}
			// A change to a global memory, even of its title only, asks again.
			const change = ["Allow once"];
			expect(await run({ op: "set", id: "M1", title: "Global rule changed" }, { selects: change })).toMatch(
				/^Updated M1/,
			);
			expect(change).toEqual([]);
			const remove = ["Allow once"];
			expect(await run({ op: "delete", id: "M2" }, { selects: remove })).toMatch(/^Deleted M2/);
			expect(remove).toEqual([]);
			expect(run.entries.map((entry) => entry.data)).toEqual(
				Array.from({ length: 4 }, () => expect.objectContaining({ allowed: true, via: "user" })),
			);
		},
	);

	it("saves nothing when the user denies a global or pinned memory, and says so", async () => {
		const run = memoryTool("workspace");
		await expect(run({ op: "set", title: "Injected rule", scope: "global" }, { selects: ["Deny"] })).rejects.toThrow(
			/user denied/,
		);
		await expect(run({ op: "set", title: "Injected pin", pinned: true }, { selects: ["Deny"] })).rejects.toThrow(
			/user denied/,
		);
		expect(await run({ op: "list" })).toContain("memories: 0 matches");
	});

	it("refuses a global or pinned memory when no one can be asked, with the reason", async () => {
		const run = memoryTool("workspace");
		await expect(run({ op: "set", title: "Headless rule", scope: "global" }, { hasUI: false })).rejects.toThrow(
			/needs the user's approval .*no one can be asked/,
		);
		await expect(run({ op: "set", title: "Headless pin", pinned: true }, { hasUI: false })).rejects.toThrow(
			/needs the user's approval/,
		);
		expect(await run({ op: "list" })).toContain("memories: 0 matches");
		expect(run.entries.map((entry) => entry.data)).toEqual([
			expect.objectContaining({ allowed: false, via: "headless" }),
			expect.objectContaining({ allowed: false, via: "headless" }),
		]);
	});

	it("follows full mode, which allows changes that reach later sessions without a dialog", async () => {
		const run = memoryTool("full");
		expect(await run({ op: "set", title: "Full rule", scope: "global" }, { hasUI: false })).toMatch(
			/^Saved M\d+ \(global/,
		);
	});
});
