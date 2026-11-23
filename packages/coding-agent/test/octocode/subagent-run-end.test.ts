import fs from "node:fs";
import path from "node:path";
import { runToolCall } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import type * as Config from "../../src/config.ts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";
import { agentModes } from "../../src/octocode/native/tools/agent/tool.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import type * as ChildTasks from "../../src/octocode/subagents/child-tasks.ts";
import { finishChildNotes } from "../../src/octocode/subagents/child-tasks.ts";
import { providerHealth } from "../../src/octocode/subagents/provider-health.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCachePolicy, fakeCtx, fakeHost, fakePermission, meteredBilling } from "./fake-host.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

// The child is the scripted stand-in, started the way the real one is.
vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof Config>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

// The parent's own bookkeeping after a run, wrapped so one test can make it fail.
vi.mock("../../src/octocode/subagents/child-tasks.ts", async (original) => {
	const actual = await original<typeof ChildTasks>();
	return { ...actual, finishChildNotes: vi.fn(actual.finishChildNotes) };
});

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-agent-esc-");
	resetOctocodeEnv();
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team", "team.sqlite"),
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

/** The `agent` tool as the agent loop runs it: the unified tool over the real task mode, through the session's wrapper. */
function setup() {
	const f = fakeHost();
	const team = new Team(f.api);
	const modes = agentModes();
	const control = registerAgentTool(f.api, {
		profiles: () => new Map(),
		team,
		permission: fakePermission(),
		refused: () => new Map(),
		registerTool: modes.collect,
	});
	modes.register(withNativePermissionOwners(f.api));
	const ctx = fakeCtx({ cwd: tmp("octocode-agent-esc-cwd-"), hasUI: true });
	const models = [{ provider: "faux", id: "model", reasoning: true }];
	Object.assign(ctx, {
		model: models[0],
		modelRegistry: {
			...meteredBilling,
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			getCachePolicy: fakeCachePolicy,
			getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
		},
	});
	team.start(ctx);
	const tool = wrapToolDefinition(f.tools.get("agent"), () => ctx as never);
	const run = (fields: Record<string, unknown>) =>
		f.tools
			.get("agent")
			.execute("call-1", { type: "task", goal: "check things", reason: "test", ...fields }, undefined, undefined, ctx);
	return { tool, team, control, run };
}

const text = (result: { content: Array<{ text?: string }> }) =>
	result.content.map((part) => part.text ?? "").join("\n");

describe("Esc on a foreground agent call", () => {
	// The parent's loop waits `abortGraceMs` for a tool to settle after an abort, then abandons it with a bare error: the
	// call's details (the child's id and saved conversation) and its usage would be lost, and the session would record
	// neither the child nor what it spent. A child that ignores the abort is stopped by closing its input after
	// `ABORT_SETTLE_MS`, so the call settles about a second after the Esc.
	it("keeps the child's record and its spend when the child takes the slow stop path", async () => {
		const { tool, team, control } = setup();
		const turn = new AbortController();
		try {
			const pending = runToolCall(
				{
					type: "toolCall",
					id: "call-1",
					name: "agent",
					arguments: { type: "task", goal: "check things", task: "spent then deaf", reason: "test" },
				},
				{
					tools: [tool],
					assistantMessage: fauxAssistantMessage("Continue"),
					context: { messages: [], tools: [tool] },
					signal: turn.signal,
				},
			);
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			turn.abort();
			const outcome = await pending;
			expect(outcome.isError).toBe(true);
			expect(outcome.result.details).toMatchObject({ id: expect.any(String), status: "failed" });
			expect(outcome.result.usage?.cost.total).toBeCloseTo(0.01);
		} finally {
			await control.stopAll();
			team.stop();
		}
	}, 30_000);
});

describe("a foreground run's end", () => {
	it("delivers the report when the parent's bookkeeping after it fails", async () => {
		const { team, control, run } = setup();
		vi.mocked(finishChildNotes).mockRejectedValueOnce(new Error("item store is locked"));
		try {
			const reply = await run({ task: "report from the foreground" });
			expect(reply.details.status).toBe("done");
			expect(text(reply)).toMatch(/^Subagent \S+ (finished|reported)/);
			expect(text(reply)).toContain("item store is locked");
			expect(reply.usage?.cost.total).toBeGreaterThan(0);
		} finally {
			await control.stopAll();
			team.stop();
		}
	}, 30_000);

	it("keeps the child's user-facing Fix line out of what the parent model reads", async () => {
		const { team, control, run } = setup();
		try {
			const reply = await run({ task: "credential fix" });
			expect(reply.isError).toBe(true);
			expect(text(reply)).toContain("security token included in the request is expired");
			expect(text(reply)).not.toContain("Fix:");
			expect(text(reply)).not.toContain("aws sso login");
		} finally {
			await control.stopAll();
			team.stop();
		}
	}, 30_000);

	it("records provider health against the model that ran after a fallback, not the planned one", async () => {
		const { team, control, run } = setup();
		try {
			// The planned provider refused its credential before; the child's fallback moved it to `alt`, which answered.
			providerHealth.noteRun("faux/model", "401 invalid x-api-key");
			const reply = await run({ task: "fell back" });
			expect(reply.details.status).toBe("done");
			expect(text(reply)).toContain("ran on alt/shared");
			expect(providerHealth.refused("faux")).toBe(true);
			// The same run failing on `alt`: the refusal is alt's.
			providerHealth.credentialChanged("faux");
			const failed = await run({ task: "fell back and failed" });
			expect(failed.isError).toBe(true);
			expect(providerHealth.refused("alt")).toBe(true);
			expect(providerHealth.refused("faux")).toBe(false);
			// The advice names the provider that refused.
			expect(text(failed)).toContain("alt credential");
			expect(text(failed)).not.toContain("faux credential");
		} finally {
			providerHealth.credentialChanged("faux");
			providerHealth.credentialChanged("alt");
			await control.stopAll();
			team.stop();
		}
	}, 30_000);
});
