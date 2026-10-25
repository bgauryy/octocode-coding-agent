import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCallEvent } from "../../src/core/extensions/index.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { isolatedTreeRefusal } from "../../src/octocode/permission/isolated-tree.ts";
import { PERMISSION_ENV, SUBAGENT_ENV, AGENT_SCRATCH_ENV, TEAM_WORKSPACE_ENV } from "../../src/octocode/shared/env.ts";

import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

/**
 * An isolated child (`isolate: true`) works in its own worktree, a separate git root, and the parent hands it the main
 * tree's root as the team workspace. A write into the main tree is `file.outside`, which `full` allows; the gate
 * refuses it in every mode.
 */
function repo(): string {
	const dir = fs.realpathSync(tmp());
	execSync("git init -q", { cwd: dir });
	return dir;
}

function isolated(mode: "full" | "workspace" | "manual") {
	const main = repo();
	const worktree = repo();
	const scratch = path.join(main, ".octocode/tmp/agents/impl-1");
	fs.mkdirSync(scratch, { recursive: true });
	const env = {
		[SUBAGENT_ENV]: "1",
		[PERMISSION_ENV]: mode,
		[TEAM_WORKSPACE_ENV]: main,
		[AGENT_SCRATCH_ENV]: scratch,
	};
	const fake = fakePi();
	const ctx = fakeCtx({ cwd: worktree, hasUI: false });
	const permission = new Permission({ pi: fake.pi, env, isSubagent: true });
	permission.start(ctx);
	const gate = permissionGate({
		permission,
		provenance: { check: () => undefined },
		env,
	});
	let id = 0;
	const attempt = async (toolName: string, input: Record<string, unknown>) => {
		const event = { type: "tool_call", toolCallId: `t${++id}`, toolName, input } as ToolCallEvent;
		const verdict = await gate(event, ctx);
		return verdict?.block ? (verdict.reason ?? "blocked") : undefined;
	};
	return { main, worktree, scratch, attempt, env };
}

const write = (file: string) => ({ queries: [{ type: "write", path: file, content: "x", reason: "test" }] });

describe.each(["full", "workspace", "manual"] as const)("isolated subagent in %s mode", (mode) => {
	it("refuses `file` writes and shell writes into the main tree, even by absolute path", async () => {
		const { main, attempt } = isolated(mode);
		const target = path.join(main, "src/a.ts");
		expect(await attempt("file", write(target))).toMatch(/isolated.*main tree/);
		expect(await attempt("bash", { command: `echo hi > ${target}` })).toMatch(/isolated.*main tree/);
		expect(await attempt("bash", { command: `rm ${target}` })).toMatch(/isolated.*main tree/);
	});

	it("allows its own worktree and its scratch folder in the main tree", async () => {
		const { worktree, scratch, attempt } = isolated(mode);
		const own = await attempt("file", write(path.join(worktree, "a.ts")));
		const note = await attempt("file", write(path.join(scratch, "report.md")));
		expect(own ?? "").not.toMatch(/main tree/);
		expect(note ?? "").not.toMatch(/main tree/);
		expect((await attempt("bash", { command: `echo hi > ${path.join(scratch, "r.md")}` })) ?? "").not.toMatch(
			/main tree/,
		);
	});
});

describe("isolatedTreeRefusal", () => {
	it("leaves a main session, a shared-tree subagent and an unrelated path alone", () => {
		const main = repo();
		const worktree = repo();
		const event = { toolName: "file", input: write(path.join(main, "a.ts")) };
		expect(isolatedTreeRefusal(event, worktree, {})).toBeUndefined();
		expect(isolatedTreeRefusal(event, worktree, { [TEAM_WORKSPACE_ENV]: main })).toBeUndefined();
		// A subagent whose own root is the team workspace is not isolated.
		expect(isolatedTreeRefusal(event, main, { [SUBAGENT_ENV]: "1", [TEAM_WORKSPACE_ENV]: main })).toBeUndefined();
		const env = { [SUBAGENT_ENV]: "1", [TEAM_WORKSPACE_ENV]: main };
		expect(isolatedTreeRefusal(event, worktree, env)).toMatch(/isolated/);
		expect(isolatedTreeRefusal({ toolName: "file", input: write(path.join(repo(), "a.ts")) }, worktree, env)).toBe(
			undefined,
		);
	});
});
