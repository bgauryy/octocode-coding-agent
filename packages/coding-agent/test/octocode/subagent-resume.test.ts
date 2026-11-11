import fs from "node:fs";
import path from "node:path";
import { type CachePreferenceLayer, mergeCachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { canonicalPath } from "../../../common/src/canonical-path.ts";
import { scratchRoot } from "../../src/octocode/subagents/handoff/scratch.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakePermission, fakeHost, meteredBilling } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
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
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

/** A parent session in `cwd` whose saved entries are `entries` (what `/resume` reopens). */
function setup(cwd: string, entries: unknown[] = []) {
	const f = fakeHost();
	const team = new Team(f.api);
	const control = registerAgentTool(f.api, { profiles: () => new Map(), team, permission: fakePermission("full") });
	const ctx = fakeCtx({ cwd });
	Object.assign(ctx, {
		model: { provider: "faux", id: "model" },
		modelRegistry: {
			...meteredBilling,
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
			expect(session.id).not.toBe(id);
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
		const { id: sessionId, dir } = details.session as { id: string; dir: string };
		// The fixture answers without saving its conversation; Octocode would have written this file.
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`), "{}\n");
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
			expect(report).toContain(`--session-dir ${dir} --session-id ${sessionId}`);
			expect(report).toContain("Follow-up from your coordinator:\nlinger again");
			// Without a goal the continued child keeps the one it was started with.
			const kept = await resumed.call({ task: "linger kept", resume: id, background: true });
			expect(kept.details).toMatchObject({ id, goal: "linger first" });
			await resumed.control.settle();
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

describe("resuming a child that crashed while starting", () => {
	it("records the foreground child, refuses another profile, and starts it again with its original task", async () => {
		const cwd = tmp();
		const first = setup(cwd);
		const input = { goal: "start late", task: "startup until 3" };
		let details: Record<string, unknown>;
		try {
			// A bundled child gets one retry: both starts crash while loading, and nothing is saved.
			const error = (await first.call(input).then(
				() => undefined,
				(thrown: unknown) => thrown,
			)) as { message: string; result?: { details: Record<string, unknown> } };
			expect(error.message).toMatch(/^Subagent failed \(startup\)/);
			details = structuredClone(error.result!.details);
			expect(details).toMatchObject({ status: "failed", startup: { failed: true } });
		} finally {
			await first.control.stopAll();
			first.team.stop();
		}
		const id = details.id as string;
		const resumed = setup(cwd, recorded(input, details, true));
		try {
			await expect(
				resumed.call({ goal: "start late", task: "go on", resume: id, profile: "reviewer" }),
			).rejects.toThrow(
				`${id} ran as general, and a resume keeps that profile. Omit profile to continue it, or start a new agent as reviewer.`,
			);
			const result = await resumed.call({ goal: "start late", task: "go on", resume: id });
			expect(result.isError).toBeFalsy();
			expect(result.details.id).toBe(id);
			const text = result.content[0].text;
			expect(text).toContain("RECOVERED on start 3: startup until 3");
			expect(text).toContain("Follow-up from your coordinator:\ngo on");
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
		// A resume names it too, in its own words: the child ended with the session.
		expect(resumed.f.sent.map((entry) => String(entry.message.content))).toEqual([
			expect.stringMatching(/^\[Resume\].*general-inflight \(/s),
		]);
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
