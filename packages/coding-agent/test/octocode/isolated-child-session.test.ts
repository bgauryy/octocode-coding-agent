import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withIdentity } from "../../src/octocode/instructions/task.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { PERMISSION_ENV } from "../../src/octocode/shared/env.ts";
import { subagentProcessEnv, type Identity } from "../../src/octocode/subagents/process/env.ts";
import { createWorktree, type Worktree } from "../../src/octocode/subagents/worktree.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { tmp } from "./helpers.ts";

/**
 * An isolated subagent from the parent's launch to the child's first model request, in one process.
 *
 * Real: the git worktree (`createWorktree`), the task text (`withIdentity`), the environment the parent hands the child
 * (`subagentProcessEnv`), the child's session with its turn setup (`registerTurnSetup`), the permission gate on every
 * tool call, and the request the faux provider receives.
 * Gap: no child process is spawned and the `file` tool is a stub that records execution, so the real CLI start (which
 * reads these environment variables) and the real `file` implementation are not exercised here. Process launch with the
 * same environment is covered in `subagent-tool.test.ts` (`subagent-fake-pi.cjs` reports the child's environment and
 * task), and the gate's refusal rules in `permission-isolated-tree.test.ts`.
 */
describe("isolated subagent session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.unstubAllEnvs();
	});

	function mainCheckout(): string {
		const dir = fs.realpathSync(tmp());
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
		git("init", "-q");
		fs.writeFileSync(path.join(dir, "AGENTS.md"), "Main rules.\n");
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
		return dir;
	}

	it("shows the main checkout in its first request, names the worktree in its task and refuses writes to the main tree", async () => {
		const main = mainCheckout();
		const worktree: Worktree = await createWorktree(main, "child-1", tmp());
		const cwd = fs.realpathSync(worktree.cwd);
		const identity: Identity = {
			id: "child-1",
			role: "implementer",
			parentId: "parent-1",
			isolation: { path: worktree.path, repo: worktree.repo, cwd },
			workspace: main,
		};
		const task = withIdentity("Change a file.", identity);
		const env = subagentProcessEnv(undefined, { [PERMISSION_ENV]: "full" }, identity);
		for (const key of ["OCTOCODE_SUBAGENT", "OCTOCODE_WORKTREE_ROOT", "OCTOCODE_PROMPT_ROOT"]) {
			vi.stubEnv(key, env[key]);
		}

		let executed = false;
		const file: AgentTool = {
			name: "file",
			label: "File",
			description: "Stub of the file tool.",
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async () => {
				executed = true;
				return { content: [{ type: "text", text: "written" }], details: {} };
			},
		};
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					const permission = new Permission({ pi, env, isSubagent: true });
					pi.on("session_start", (_event, ctx) => permission.start(ctx));
					const gate = permissionGate({
						permission,
						provenance: { check: () => undefined },
						env,
					});
					pi.on("tool_call", (event, ctx) => gate(event, ctx));
					registerTurnSetup(pi, {
						isSubagent: true,
						profiles: () => new Map(),
					});
				},
			],
			cwd,
		);
		const resourceLoader = {
			...createTestResourceLoader({ extensionsResult }),
			getAgentsFiles: () => ({ agentsFiles: [{ path: path.join(cwd, "AGENTS.md"), content: "Rules." }] }),
		};
		const harness = await createHarness({ cwd, tools: [file], resourceLoader });
		harnesses.push(harness);

		const target = path.join(main, "intruder.txt");
		const requests: string[] = [];
		const record = (context: { messages: Array<{ role: string; content?: unknown; sections?: object }> }) => {
			const system = context.messages.filter((message) => message.role === "system");
			requests.push(
				system.map((message) => `${message.content}\n${Object.values(message.sections ?? {}).join("\n")}`).join("\n"),
			);
		};
		harness.setResponses([
			(context) => {
				record(context);
				return fauxAssistantMessage(
					[fauxToolCall("file", { queries: [{ type: "write", path: target, content: "x", reason: "test" }] })],
					{ stopReason: "toolUse" },
				);
			},
			() => fauxAssistantMessage("done"),
		]);

		await harness.session.prompt(task);

		const prompt = requests[0] ?? "";
		// The system prompt names the main checkout, so sibling children share one cached prefix.
		expect(prompt).toContain(`<project_instructions path="${path.join(main, "AGENTS.md")}">`);
		expect(prompt).toContain(main);
		expect(prompt).not.toContain(worktree.path);
		expect(prompt).not.toContain(cwd);
		// The task names the real worktree.
		const user = harness.session.messages.find((message) => message.role === "user");
		const text = JSON.stringify(user?.content);
		expect(text).toContain("## Worktree");
		expect(text).toContain(cwd);
		// A write into the main tree is refused before the tool runs.
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result?.content)).toMatch(/isolated.*main tree/);
		expect(executed).toBe(false);
		expect(fs.existsSync(target)).toBe(false);
	}, 30_000);
});
