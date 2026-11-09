import fs from "node:fs";
import path from "node:path";
import { type CachePreferenceLayer, mergeCachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { fencedParts, PARENT_FENCE_NOTE } from "../../src/octocode/shared/fence.ts";
import type { ReferencedMessage } from "../../src/octocode/child-sessions/references.ts";
import { BLOCKED_LINGER_SECONDS } from "../../src/octocode/subagents/claim.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

beforeAll(() => {
	const root = tmp("octocode-task-refs-");
	for (const key of Object.keys(process.env)) if (key.startsWith("OCTOCODE_")) delete process.env[key];
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
	});
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

const profiles = new Map<string, AgentProfile>([
	["lean", { name: "lean", description: "lean", prompt: "Do the task.", tools: "bash,file", lean: true }],
]);

type Result = { content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean };

/** A parent session whose saved entries are `entries`; its team store is stubbed with `messages` (sent by or to the parent). */
function setup(entries: unknown[] = [], messages: Record<number, Omit<ReferencedMessage, "id" | "at">> = {}) {
	const f = fakeHost();
	const team = new Team(f.api);
	const asked: number[] = [];
	Object.assign(team, {
		readMessage: (id: number, requester: string) => {
			asked.push(id);
			const found = messages[id];
			return found && requester === team.id ? { id, at: Date.now(), ...found } : { error: "not found" };
		},
		unansweredPeerAsks: () => 0,
	});
	const permission = fakePermission("full");
	const control = registerAgentTool(f.api, () => profiles, team, permission);
	const ctx = fakeCtx({ cwd: tmp() });
	Object.assign(ctx, {
		model: { provider: "faux", id: "model" },
		modelRegistry: {
			getAvailable: () => [],
			find: () => undefined,
			getCachePolicy: (_model: unknown, settings: readonly CachePreferenceLayer[] = []) =>
				mergeCachePreferences(settings),
		},
	});
	Object.assign((ctx as { sessionManager: object }).sessionManager, { getEntries: () => entries });
	team.start(ctx);
	const call = async (input: Record<string, unknown>) =>
		(await f.tools.get("agent").execute("call-1", { goal: "use refs", ...input }, undefined, undefined, ctx)) as Result;
	const finish = async () => {
		await control.stopAll();
		team.stop();
	};
	return { f, team, control, ctx, call, asked, finish };
}

/** The `agent` call and result a session records for a finished foreground child. */
const recorded = (input: Record<string, unknown>, result: Result): unknown[] => [
	{
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "agent", arguments: input }] },
	},
	{
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "agent",
			content: result.content.map((part) => ({ type: "text", text: part.text })),
			details: { ...result.details, agentType: "task" },
		},
	},
];

/** The child's answer (the whole task it received, as the fixture echoes it). */
const childTask = (result: Result) => fencedParts(result.content[0].text)?.body ?? "";

describe("references in an agent task", () => {
	it("heads a report with its citable id, and expands that report and a message into a later task", async () => {
		const first = setup();
		let input: Record<string, unknown>;
		let reported: Result;
		try {
			input = { task: "echo whole task: findings are A and B" };
			reported = await first.call(input);
		} finally {
			await first.finish();
		}
		const id = reported.details.id as string;
		expect(reported.content[0].text.split("\n")[0]).toBe(`Subagent ${id} finished · cite as report:${id}:`);

		const parent = setup(recorded(input, reported), { 4: { from: "peer-a", text: "use the v2 schema" } });
		try {
			// A parent that sent or received messages has joined the team (sending joins it).
			const parentId = parent.team.join().id;
			const result = await parent.call({ task: `echo whole task: continue from report:${id} and msg#4.` });
			const task = childTask(result);
			const [own, referenced] = task.split("\n\n## Referenced content\n\n");
			expect(own).toBe(`echo whole task: continue from report:${id} and msg#4.`);
			expect(referenced).toContain(`report:${id}: Report of subagent ${id} (general: use refs)`);
			expect(referenced).toContain("echo whole task: findings are A and B");
			expect(referenced).toMatch(/msg#4: Message #4 from agent peer-a at .* \(sha256 [0-9a-f]{12}\)/);
			expect(referenced).toContain("use the v2 schema");
			// Identity follows the expanded content: references sit with the parent's task, before `## You`.
			expect(referenced.lastIndexOf("\n\n## You\n")).toBeGreaterThan(referenced.indexOf("use the v2 schema"));
			expect(parent.asked).toEqual([4]);
			expect(parentId).toBeTruthy();
		} finally {
			await parent.finish();
		}
	}, 30_000);

	it("expands references for a lean child, which has no tool to read them, and keeps the parent's own message as steering", async () => {
		const t = setup([], {});
		try {
			t.team.join();
			Object.assign(t.team, {
				readMessage: (id: number) => ({ id, at: Date.now(), from: t.team.id!, text: "constraints: keep the API" }),
			});
			const result = await t.call({ task: "echo whole task per msg#12", profile: "lean" });
			const task = childTask(result);
			expect(task).toContain("## Referenced content");
			expect(task).toContain("constraints: keep the API");
			expect(task).toContain(PARENT_FENCE_NOTE);
		} finally {
			await t.finish();
		}
	}, 30_000);

	it("refuses a task citing unresolvable references before asking or starting anything, naming each", async () => {
		const t = setup();
		try {
			await expect(t.call({ task: "echo whole task with msg#77 and report:nobody", background: true })).rejects.toThrow(
				'No subagent started: the task cites references that cannot be resolved: msg#77: not found; report:nobody: no subagent "nobody" was started by this session.',
			);
			expect(t.control.running()).toEqual([]);
			expect(t.f.sent).toEqual([]);
		} finally {
			await t.finish();
		}
	});

	it("leaves a task without references unchanged", async () => {
		const t = setup();
		try {
			const task = childTask(await t.call({ task: "echo whole task: #12, B205 and msg#N are not references" }));
			expect(task).not.toContain("## Referenced content");
			expect(t.asked).toEqual([]);
		} finally {
			await t.finish();
		}
	});
});

describe("a background subagent with an unanswered replyRequired ask to a peer", () => {
	it("stays resumable for the blocked window with the linger setting at 0, and its report cites it", async () => {
		const t = setup();
		try {
			const asks = vi.fn(() => 1);
			Object.assign(t.team, { unansweredPeerAsks: asks });
			const started = await t.call({ task: "linger asking a peer", background: true });
			const id = started.details.id as string;
			await t.control.settle();
			const report = String(t.f.sent.find((entry) => entry.message.details?.id === id)?.message.content);
			expect(asks).toHaveBeenCalledWith(id);
			expect(report.split("\n")[0]).toMatch(new RegExp(`^Background subagent ${id} .* · cite as report:${id}:$`));
			expect(report).toContain(
				`${id} is waiting for a reply to its question to another agent and stays resumable for ${BLOCKED_LINGER_SECONDS} s`,
			);
			expect(report).not.toContain("waiting for your reply");
		} finally {
			await t.finish();
		}
	}, 30_000);
});
