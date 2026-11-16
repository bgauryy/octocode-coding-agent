import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCallEvent } from "../../src/core/features/index.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { withIdentity } from "../../src/octocode/instructions/task.ts";
import { stateFolderRefusal } from "../../src/octocode/permission/file-access.ts";
import { Isolation } from "../../src/octocode/subagents/isolation.ts";
import { grantFolder } from "../../src/octocode/trust/grants.ts";
import { resolveFolderTrust } from "../../src/octocode/trust/resolve.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import { subagentProcessEnv, type Identity } from "../../src/octocode/subagents/process/env.ts";
import { createWorktree, type Worktree } from "../../src/octocode/subagents/worktree.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { headlessFileTool } from "./permission-file-harness.ts";

/**
 * An isolated subagent from the parent's launch to the child's first model request, in one process.
 *
 * Real: the git worktree (`createWorktree`), the task text (`withIdentity`), the environment the parent hands the child
 * (`subagentProcessEnv`), the child's session with its turn setup (`registerTurnSetup`), the permission gate on every
 * tool call, and the request the faux provider receives.
 * Gap: no child process is spawned, so the real CLI start (which reads these environment variables) is not exercised
 * here; the first case's `file` tool is a stub that records execution, and the real-home cases run the real one. Process launch with the
 * same environment is covered in `subagent-tool.test.ts` (`subagent-fake-host.cjs` reports the child's environment and
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
				(api) => {
					const permission = new Permission({ api, env, isSubagent: true });
					api.on("session_start", (_event, ctx) => permission.start(ctx));
					const gate = permissionGate({
						permission,
						provenance: { check: () => undefined },
						env,
					});
					api.on("tool_call", (event, ctx) => gate(event, ctx));
					registerTurnSetup(api, {
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
					[
						fauxToolCall("file", {
							reason: "Write into the main checkout",
							queries: [{ type: "write", path: target, content: "x", reason: "test" }],
						}),
					],
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
		expect(text).toContain(cwd);
		// A write into the main tree is refused before the tool runs.
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result?.content)).toMatch(/isolated.*main tree/);
		expect(executed).toBe(false);
		expect(fs.existsSync(target)).toBe(false);
	}, 30_000);

	describe("in a worktree under the real Octocode home", () => {
		/** Everything below is where production puts it: `<HOME>/.octocode/octocodecode/worktrees/<repo>/<id>`, outside the suite's trusted temp folder. */
		async function childWorktree(id = "child-2") {
			const home = tmp("octocode-real-home-");
			vi.stubEnv("HOME", home);
			vi.stubEnv("OCTOCODE_HOME", "");
			vi.stubEnv("OCTOCODE_AGENT_DB", path.join(tmp("octocode-real-db-"), "octocode.db"));
			closeSharedAgentDb();
			const main = mainCheckout();
			grantFolder(main, "folder", { source: "command", surface: "cli" });
			const ask = vi.fn(async () => false);
			const worktree = await createWorktree(main, id, undefined, false, undefined, ask);
			expect(ask).not.toHaveBeenCalled();
			expect(worktree.path).toContain(path.join(home, ".octocode", "octocodecode", "worktrees"));
			vi.stubEnv("OCTOCODE_SUBAGENT", "1");
			vi.stubEnv("OCTOCODE_WORKTREE_ROOT", worktree.path);
			vi.stubEnv("OCTOCODE_TEAM_WORKSPACE", main);
			return { main, worktree, cwd: fs.realpathSync(worktree.cwd) };
		}
		const shellGate = (cwd: string) => {
			const fake = fakeHost();
			const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: "full" }, isSubagent: true });
			const ctx = fakeCtx({ cwd, hasUI: false });
			permission.start(ctx);
			const gate = permissionGate({ permission, provenance: { check: () => undefined } });
			let id = 0;
			return async (command: string) => {
				const event = { type: "tool_call", toolCallId: `s${++id}`, toolName: "bash", input: { command } };
				return (await gate(event as ToolCallEvent, ctx))?.reason;
			};
		};
		afterEach(() => closeSharedAgentDb());

		it("writes with the real file tool and parsed shell commands, and is refused the main tree and a sibling", async () => {
			const { main, cwd, worktree } = await childWorktree();
			const { write } = headlessFileTool("full", cwd, { isSubagent: true });
			expect(await write("from-child.txt", "landed")).toBeUndefined();
			expect(fs.readFileSync(path.join(cwd, "from-child.txt"), "utf8")).toBe("landed");

			const shell = shellGate(cwd);
			for (const command of ["echo x > a.txt", "git commit -am x", "mkdir newdir", "rm a.txt"])
				expect(await shell(command), command).toBeUndefined();
			expect(await shell(`git -C ${main} reset --hard`)).toMatch(/isolated.*main tree/);

			// A sibling's worktree, in the same folder, stays the state folder for this child.
			const sibling = path.join(path.dirname(worktree.path), "other-child");
			fs.mkdirSync(sibling);
			expect(await write(path.join(sibling, "x.txt"))).toMatch(/state folder/);
			expect(await shell(`echo x > ${sibling}/x.txt`)).toMatch(/state folder/);
			expect(fs.existsSync(path.join(sibling, "x.txt"))).toBe(false);
		}, 30_000);

		it("keeps `.octocode/code` inside the worktree refused, and a link out of it", async () => {
			const { cwd } = await childWorktree();
			const { write } = headlessFileTool("full", cwd, { isSubagent: true });
			expect(await write(".octocode/code/settings.json", "{}")).toMatch(/state folder/);
			const state = path.join(process.env.HOME!, ".octocode", "octocodecode");
			fs.symlinkSync(path.join(state, "settings.json"), path.join(cwd, "link.json"));
			expect(await write("link.json", "{}")).toMatch(/state folder/);
			expect(fs.existsSync(path.join(state, "settings.json"))).toBe(false);
		}, 30_000);

		it.each([
			["the home", (root: string) => path.dirname(path.dirname(path.dirname(root)))],
			["the repository's folder of worktrees", (root: string) => path.dirname(root)],
			["a folder under the worktree", (root: string) => path.join(root, "sub")],
			["a sibling", (root: string) => path.join(path.dirname(root), "other-child")],
		])(
			"grants nothing when the variable names %s",
			async (_name, spoofed) => {
				const { cwd, worktree } = await childWorktree();
				const target = path.join(worktree.path, "x.txt");
				expect(stateFolderRefusal(target, "x.txt", "file", cwd)).toBeUndefined();
				const value = spoofed(worktree.path);
				fs.mkdirSync(value, { recursive: true });
				const refused = (from: string) =>
					stateFolderRefusal(target, "x.txt", "file", from, { OCTOCODE_WORKTREE_ROOT: value });
				expect(refused(cwd)).toMatch(/state folder/);
				// Not by running from inside the named folder either: only a real worktree of this repository counts.
				expect(
					stateFolderRefusal(path.join(value, "y"), "y", "file", value, { OCTOCODE_WORKTREE_ROOT: value }),
				).toMatch(/state folder/);
				// Without saying where the process runs there is no exception at all.
				expect(stateFolderRefusal(target, "x.txt", "file")).toMatch(/state folder/);
			},
			30_000,
		);

		it("asks for an untrusted checkout, and its question is dismissed with the launch", async () => {
			const home = tmp("octocode-real-home-");
			vi.stubEnv("HOME", home);
			vi.stubEnv("OCTOCODE_HOME", "");
			vi.stubEnv("OCTOCODE_AGENT_DB", path.join(tmp("octocode-real-db-"), "octocode.db"));
			closeSharedAgentDb();
			const main = mainCheckout();
			const controller = new AbortController();
			const confirm = vi.fn(async (_title: string, _message: string, options?: { signal?: AbortSignal }) => {
				expect(options?.signal).toBe(controller.signal);
				controller.abort(new Error("stopped"));
				return false;
			});
			const isolation = new Isolation("child-3");
			const identity = { id: "child-3" };
			await expect(
				isolation.start({ cwd: main, hasUI: true, ui: { confirm } } as never, identity, false, controller.signal),
			).rejects.toThrow("stopped");
			expect(confirm).toHaveBeenCalledOnce();
			expect(confirm.mock.calls[0]?.[0]).toMatch(/Trust new worktree/);
		}, 30_000);

		it("records the grant the child reads at start, without asking, for a trusted checkout", async () => {
			const { worktree } = await childWorktree("child-4");
			expect(resolveFolderTrust(worktree.path).state).toBe("trusted");
		}, 30_000);
	});
});
