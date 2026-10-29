import fs from "node:fs";
import path from "node:path";
import { type CachePreferenceLayer, mergeCachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { canonicalPath } from "../../src/octocode/shared/home/repo.ts";
import { scratchRoot } from "../../src/octocode/subagents/handoff/scratch.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakePermission, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-pi.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-agent-resume-");
	for (const key of Object.keys(process.env)) if (key.startsWith("OCTOCODE_")) delete process.env[key];
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
	});
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "pi"));
	process.argv[1] = path.join(bin, "pi");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

/** A parent session in `cwd` whose saved entries are `entries` (what `/resume` reopens). */
function setup(cwd: string, entries: unknown[] = []) {
	const f = fakePi();
	const team = new Team(f.pi);
	const control = registerAgentTool(f.pi, () => new Map(), team, fakePermission("full"));
	const ctx = fakeCtx({ cwd });
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
	const reports = () => f.sent.map((entry) => String(entry.message.content)).filter((text) => text.includes("LINGER"));
	const call = async (input: Record<string, unknown>) =>
		(await f.tools.get("agent").execute("call-1", input, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
			details: Record<string, unknown>;
			isError?: boolean;
		};
	return { f, team, control, ctx, reports, call };
}

/** The `agent` call and result a session records for `details`. */
const recorded = (input: Record<string, unknown>, details: Record<string, unknown>, isError = false): unknown[] => [
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "agent", arguments: { type: "task", input } }],
		},
	},
	{
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "agent",
			isError,
			details: { ...details, agentType: "task" },
		},
	},
];

describe("resuming a subagent of this session by id", () => {
	it("records the child's session folder when a background run starts", async () => {
		const cwd = tmp();
		const t = setup(cwd);
		try {
			const { details } = await t.call({ goal: "linger first", task: "linger first", background: true });
			const id = details.id as string;
			const session = details.session as { id: string; dir: string };
			expect(session.id).toBe(id);
			expect(canonicalPath(session.dir)).toBe(canonicalPath(path.join(scratchRoot(cwd), id, "session")));
		} finally {
			await t.control.stopAll();
			t.team.stop();
		}
	}, 30_000);

	it("continues a failed foreground child on its recorded transcript, and refuses an unknown id", async () => {
		const cwd = tmp();
		const first = setup(cwd);
		let input: Record<string, unknown>;
		let details: Record<string, unknown>;
		try {
			input = { goal: "linger first", task: "error please" };
			const failedForeground = await first.call(input);
			expect(failedForeground.isError).toBe(true);
			expect(failedForeground.details.status).toBe("failed");
			details = structuredClone(failedForeground.details);
			await first.control.settle();
		} finally {
			await first.control.stopAll();
			first.team.stop();
		}
		const id = details.id as string;
		const dir = (details.session as { dir: string }).dir;
		// The fixture answers without saving its conversation; Octocode would have written this file.
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`), "{}\n");
		const resumed = setup(cwd, recorded(input, details, true));
		try {
			await resumed.f.emit("session_start", { reason: "resume" }, resumed.ctx);
			await expect(
				resumed.call({ goal: "linger again", task: "linger again", resume: "general-unknown" }),
			).rejects.toThrow(
				`No subagent "general-unknown" in this session. Its subagents: ${id} (general, goal "linger first"`,
			);
			const result = await resumed.call({ goal: "linger again", task: "linger again", resume: id, background: true });
			expect(result.details.id).toBe(id);
			expect(result.details.runId).toEqual(expect.any(String));
			expect(result.details.runId).not.toBe(details.runId);
			await resumed.control.settle();
			expect(resumed.f.sent.find((entry) => entry.message.details?.id === id)?.message.details.runId).toBe(
				result.details.runId,
			);
			const [report] = resumed.reports();
			expect(report).toContain(`--session-dir ${dir} --session-id ${id}`);
			expect(report).toContain("Follow-up from your parent:\nlinger again");
			const failed = await resumed.call({ goal: "Recover", task: "error please", resume: id, background: true });
			await resumed.control.settle();
			const failure = resumed.f.sent.find((entry) => entry.message.details?.runId === failed.details.runId);
			expect(failed.details.runId).not.toBe(result.details.runId);
			expect(failure?.message.details).toMatchObject({ runId: failed.details.runId, status: "failed" });
		} finally {
			await resumed.control.stopAll();
			resumed.team.stop();
		}
	}, 30_000);
});

describe("a fork of a session whose subagents were still running", () => {
	it("tells the model which children stopped with the session it forked from, and how to continue them", async () => {
		const cwd = tmp();
		const dir = path.join(cwd, "general-inflight", "session");
		const entries = recorded(
			{ goal: "Fix the build", task: "Fix it", background: true },
			{
				id: "general-inflight",
				profile: "general",
				goal: "Fix the build",
				status: "background",
				session: { id: "general-inflight", dir },
			},
		);
		const resumed = setup(cwd, entries);
		await resumed.f.emit("session_start", { reason: "resume" }, resumed.ctx);
		expect(resumed.f.sent).toEqual([]);
		const fork = setup(cwd, entries);
		try {
			await fork.f.emit("session_start", { reason: "fork" }, fork.ctx);
			const notes = fork.f.sent.map((entry) => String(entry.message.content));
			expect(notes).toHaveLength(1);
			expect(notes[0]).toContain('general-inflight (general, goal "Fix the build", background, transcript folder');
			expect(notes[0]).toContain("`resume`");
			expect(fork.f.sent[0]?.options).toMatchObject({ triggerTurn: false });
		} finally {
			resumed.team.stop();
			fork.team.stop();
		}
	});
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));
