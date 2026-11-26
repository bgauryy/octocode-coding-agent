import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { CommandContext } from "../../src/core/features/index.ts";
import { BACKLOG_DONE_CHANNEL } from "../../src/octocode/shared/agent-chain.ts";
import { worktreeCommand } from "../../src/octocode/worktrees/command.ts";
import { orchestratorMember, registerOrchestratorNotice } from "../../src/octocode/worktrees/orchestrator-notice.ts";
import { refuseLinkedIsolation } from "../../src/octocode/subagents/worktree-create.ts";
import { octocodePrompt } from "../../src/octocode/native/prompts/policy.ts";
import { linkedSession, recordedCreator } from "../../src/octocode/worktrees/proxy.ts";
import { GIT_TEST_ENV, makeRepo, type TestRepo } from "./worktree-fixture.ts";

const saved = { ...process.env };
let repo: TestRepo;

const member = (id: string, checkout: string, joinedAt: number, extra: Partial<Member> = {}): Member =>
	({ id, role: "main", pid: 1, status: "idle", checkout, joinedAt, updatedAt: joinedAt, ...extra }) as Member;

beforeEach(() => {
	Object.assign(process.env, GIT_TEST_ENV);
	repo = makeRepo();
});
afterEach(() => {
	process.env = { ...saved };
	repo.cleanup();
});

const create = async (id: string, name: string) =>
	worktreeCommand({
		env: { ...process.env },
		invocation: () => ({ command: "octocode", prefix: [] }),
		agentId: () => id,
	}).handler(`new ${name}`, {
		cwd: repo.root,
		hasUI: true,
		ui: { notify: () => undefined },
		sessionManager: { getSessionId: () => "s" },
	} as unknown as CommandContext);

describe("a linked worktree session's orchestrator", () => {
	it("is the agent that ran /worktree new, and the shell gate names it", async () => {
		await create("sly-otter", "auth");
		const folder = realpathSync(`${repo.root}/.octocode/agent/worktrees/auth`);
		expect(recordedCreator(folder)).toBe("sly-otter");
		expect(linkedSession(folder)).toContain("sly-otter");
		expect(linkedSession(repo.root)).toBeUndefined();
	});

	it("is the oldest live main-checkout member when no creator is recorded or alive", () => {
		const members = [
			member("late", "/main", 20),
			member("early", "/main", 10),
			member("child", "/main", 5, { parentId: "early" }),
			member("self", "/wt", 1),
			member("sibling", "/wt2", 2),
		];
		expect(orchestratorMember(members, "/main")?.id).toBe("early");
		expect(orchestratorMember(members, "/main", "late")?.id).toBe("late");
		expect(orchestratorMember(members, "/main", "gone")?.id).toBe("early");
		// A session in another linked worktree is no orchestrator, even as the recorded creator.
		expect(orchestratorMember(members, "/main", "sibling")?.id).toBe("early");
		expect(orchestratorMember([member("self", "/wt", 1), member("sibling", "/wt2", 2)], "/main")).toBeUndefined();
	});
});

describe("done in a linked worktree session", () => {
	const setup = (folder: string, members: Member[]) => {
		const handlers: Record<string, (value: unknown, ctx?: unknown) => unknown> = {};
		const send = vi.fn(async (_to: string | undefined, _text: string) => ({ sent: ["x"] }));
		registerOrchestratorNotice(
			{
				bus: { on: (name: string, handler: never) => void (handlers[name] = handler) },
				channels: { on: (name: string, handler: never) => void (handlers[name] = handler), emit: () => undefined },
			} as never,
			{ members: () => members, send },
			() => undefined,
		);
		return {
			start: () => handlers.session_start({}, { cwd: folder }),
			done: () => handlers[BACKLOG_DONE_CHANNEL]({ ref: "B7", summary: "fixed it", open: false, remaining: 0 }),
			send,
		};
	};

	it("tells the orchestrator once, briefly", async () => {
		await create("sly-otter", "auth");
		const folder = realpathSync(`${repo.root}/.octocode/agent/worktrees/auth`);
		const run = setup(folder, [member("sly-otter", repo.root, 1), member("me", folder, 2)]);
		await run.start();
		run.done();
		expect(run.send).toHaveBeenCalledTimes(1);
		expect(run.send.mock.calls[0]?.[0]).toBe("sly-otter");
		expect(run.send.mock.calls[0]?.[1]).toContain("B7 is done");
	});

	it("sends nothing from the main checkout", async () => {
		const run = setup(repo.root, [member("other", repo.root, 1)]);
		await run.start();
		run.done();
		expect(run.send).not.toHaveBeenCalled();
	});
});

describe("what a linked worktree session may start", () => {
	it("refuses isolate: true, but not a child in its own tree, and the prompt says so only there", async () => {
		await create("sly-otter", "auth");
		const folder = realpathSync(`${repo.root}/.octocode/agent/worktrees/auth`);
		expect(() => refuseLinkedIsolation(folder)).toThrow(/isolated subagent.*sly-otter/s);
		expect(() => refuseLinkedIsolation(repo.root)).not.toThrow();
		const base = { profiles: [], canDelegate: true };
		expect(octocodePrompt({ ...base, linked: true })).toContain("proxy of the orchestrator");
		expect(octocodePrompt(base)).not.toContain("proxy of the orchestrator");
	});
});
