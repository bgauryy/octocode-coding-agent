import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AGENT_SCRATCH_ENV, PERMISSION_ENV, READ_ONLY_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { registerFileTool } from "../../src/octocode/native/tools/file/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { shellTargetAccess } from "../../src/octocode/permission/file-access.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { shellMutation, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { commandWriteTargets } from "../../src/octocode/permission/shell/write-targets.ts";
import { getOctocodeHome } from "../../src/config.ts";
import { fakePermission, asSetup } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

beforeAll(async () => {
	await shellParserReady();
});

/** What the state-folder guard says about a bash command: whether it refuses, and whether it could not place a write. */
function stateGuard(command: string, cwd: string) {
	const targets = commandWriteTargets({ toolName: "bash", input: { command } }, cwd);
	const access = targets.map((target) => shellTargetAccess(target, cwd));
	return {
		refusal: access.find((entry) => entry.refusal)?.refusal,
		uncertain: access.some((entry) => entry.uncertain),
	};
}

// A working directory two levels below the folder that holds the real state folder: the wrong resolution of
// `../../.octocode/tmp/f` lands in the state folder, the right one under the working directory.
const home = path.dirname(getOctocodeHome());
const deep = path.join(home, "proj", "sub");

describe("cd following in the state-folder guard", () => {
	it("lets a write after `cd name` resolve against that folder", () => {
		expect(stateGuard("cd packages/x && echo hi > ../../.octocode/tmp/f", deep)).toEqual({
			refusal: undefined,
			uncertain: false,
		});
		expect(
			stateGuard("cd packages/coding-agent && yarn test > ../../.octocode/tmp/log 2>&1", deep).refusal,
		).toBeUndefined();
	});

	it.each([
		[`echo x > ${path.join(getOctocodeHome(), "config.json")}`],
		[`cd packages/x && echo x > ${path.join(getOctocodeHome(), "config.json")}`],
		[`cd $DIR && echo x > ${path.join(getOctocodeHome(), "config.json")}`],
	])("still refuses a write into the real state folder: %s", (command) => {
		expect(stateGuard(command, deep).refusal).toMatch(/state folder/);
	});

	it.each([
		"cd $DIR && echo hi > out.txt",
		"cd - && echo hi > out.txt",
		"cd a/../b && echo hi > out.txt",
		"cd packages/x || echo hi > out.txt",
		"for d in a b; do cd $d; echo hi > out.txt; done",
	])("does not follow a cd it cannot: %s", (command) => {
		expect(stateGuard(command, deep).uncertain).toBe(true);
	});

	it("does not follow a bare name when CDPATH is set", () => {
		expect(shellMutation("CDPATH=/elsewhere; cd packages/x && echo hi > out.txt").uncertain).toBe(true);
	});
});

describe("cd following in the read-only role and the reservation check", () => {
	const repo = fs.realpathSync(tmp());
	fs.mkdirSync(path.join(repo, "packages/x"), { recursive: true });
	fs.mkdirSync(path.join(repo, ".octocode/code/temp/agents/r"), { recursive: true });
	const env = {
		[SUBAGENT_ENV]: "1",
		[READ_ONLY_ENV]: "1",
		[AGENT_SCRATCH_ENV]: path.join(repo, ".octocode/code/temp/agents/r"),
		[PERMISSION_ENV]: "full",
	};
	const refusal = (command: string) => readOnlyRoleRefusal({ toolName: "bash", input: { command } }, repo, env);

	it("lets a read-only role write its allowed folder after `cd name`", () => {
		expect(refusal("cd packages/x && echo hi > ../../.octocode/tmp/f")).toBeUndefined();
	});

	it("still refuses a read-only write the cd leads to, and a cd it cannot follow", () => {
		expect(refusal("cd packages/x && echo hi > out.txt")).toMatch(/read-only role/);
		expect(refusal("cd $DIR && echo hi > out.txt")).toMatch(/read-only role/);
		expect(refusal("cd - && echo hi > out.txt")).toMatch(/read-only role/);
	});

	it("gives the reservation check the folder the write lands in", () => {
		expect(shellMutation("cd packages/x && echo hi > ../../notes/f").writes).toEqual(["./packages/x/../../notes/f"]);
		const unknown = shellMutation("cd $DIR && echo hi > notes/f");
		expect(unknown.uncertain).toBe(true);
		expect(unknown.afterDirectoryChange).toBe(true);
	});
});

describe("file edits of an unread file", () => {
	function setup() {
		let tool: { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> } | undefined;
		registerFileTool(
			asSetup({
				registerTool: (t: typeof tool) => {
					tool = t;
					return tool;
				},
				on: () => undefined,
			}) as never,
			new FileGuard(),
			fakePermission(),
		);
		const cwd = tmp();
		const file = path.join(cwd, "a.txt");
		fs.writeFileSync(file, "one\ntwo\ntwo\nthree\n");
		const run = async (query: Record<string, unknown>) => {
			try {
				const result = await tool!.execute("c", { reason: "r", queries: [query] }, undefined, undefined, {
					cwd,
					hasUI: false,
				});
				return result.content.map((part) => part.text).join("\n");
			} catch (error) {
				return String(error);
			}
		};
		return { file, run };
	}

	it("allows an edit whose oldText matches exactly once, without a read", async () => {
		const { file, run } = setup();
		expect(await run({ type: "edit", path: "a.txt", edits: [{ oldText: "one", newText: "1" }] })).not.toMatch(
			/not read in this session/,
		);
		expect(fs.readFileSync(file, "utf8")).toBe("1\ntwo\ntwo\nthree\n");
	});

	it("allows replaceAll when every oldText matches", async () => {
		const { file, run } = setup();
		await run({ type: "edit", path: "a.txt", edits: [{ oldText: "two", newText: "2", replaceAll: true }] });
		expect(fs.readFileSync(file, "utf8")).toBe("one\n2\n2\nthree\n");
	});

	it.each([
		["an oldText that is not in the file", [{ oldText: "missing", newText: "x" }]],
		["an oldText that matches twice without replaceAll", [{ oldText: "two", newText: "x" }]],
		[
			"one anchor that matches and one that does not",
			[
				{ oldText: "one", newText: "1" },
				{ oldText: "missing", newText: "x" },
			],
		],
	])("still refuses %s, with the read instruction, and changes nothing", async (_name, edits) => {
		const { file, run } = setup();
		const refusal = await run({ type: "edit", path: "a.txt", edits });
		expect(refusal).toMatch(/already exists and was not read in this session/);
		expect(refusal).toMatch(
			/edits\[\d\] oldText (was not found in it|matches it 2 times), so the edit was not applied/,
		);
		expect(fs.readFileSync(file, "utf8")).toBe("one\ntwo\ntwo\nthree\n");
	});

	it("still needs a read before a whole-file write or a delete", async () => {
		const { file, run } = setup();
		expect(await run({ type: "write", path: "a.txt", content: "new" })).toMatch(/was not read in this session/);
		expect(await run({ type: "delete", path: "a.txt" })).toMatch(/was not read in this session/);
		expect(fs.readFileSync(file, "utf8")).toBe("one\ntwo\ntwo\nthree\n");
	});

	it("does not count an unread edit as a read for a later write", async () => {
		const { file, run } = setup();
		await run({ type: "edit", path: "a.txt", edits: [{ oldText: "one", newText: "1" }] });
		expect(await run({ type: "write", path: "a.txt", content: "new" })).toMatch(
			/changed on disk since you last read it/,
		);
		expect(fs.readFileSync(file, "utf8")).toBe("1\ntwo\ntwo\nthree\n");
	});
});
