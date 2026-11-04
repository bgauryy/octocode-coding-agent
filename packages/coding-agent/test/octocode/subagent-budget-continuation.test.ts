import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { MAX_REQUESTS_ENV } from "../../src/octocode/subagents/budget.ts";
import { childSessionFile, type ChildSession } from "../../src/octocode/subagents/process/session.ts";
import { tmp } from "./helpers.ts";
import { setup } from "./subagent-record-fixture.ts";

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

const savedArgv = process.argv[1];
const savedEnv = { ...process.env };
beforeAll(() => {
	const root = tmp("octocode-agent-budget-continuation-");
	for (const key of Object.keys(process.env)) if (key.startsWith("OCTOCODE_")) delete process.env[key];
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
	});
	const fixture = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
	process.argv[1] = path.join(root, "octocode");
	fs.copyFileSync(fixture, process.argv[1]);
});
beforeEach(() => {
	process.env[MAX_REQUESTS_ENV] = "3";
	process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
});
afterEach(() => {
	delete process.env[MAX_REQUESTS_ENV];
	delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
});
afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

describe("the task budget through native continuation routes", () => {
	it("carries message follow-ups through parked reopen under a new parent process identity", async () => {
		const first = setup();
		try {
			const started = await first.run({ task: "budget loop 2", background: true });
			const id = started.details.id;
			await first.control.settle();
			expect(await first.team.send(id, "budget loop 0", { replyRequired: false })).toHaveProperty("resumed");
			await first.control.settle();
			expect(first.sent.at(-1)?.message.details).toMatchObject({ id, requests: 1 });
			const parent = first.team.join().id;
			first.team.stop();
			const reopened = setup(first.ctx.cwd);
			try {
				await reopened.emit("session_start", {}, reopened.ctx);
				expect(reopened.team.join().id).not.toBe(parent);
				// Four saved replies, past the soft limit of 3: the message is a grant, so this run stops at 4 + 5.
				expect(await reopened.team.send(id, "budget loop 40 stop-at 5", { replyRequired: false })).toHaveProperty(
					"resumed",
				);
				await reopened.control.settle();
				expect(reopened.sent.at(-1)?.message.content).toContain("9 requests; limit 7");
				expect(reopened.sent.at(-1)?.message.details).toMatchObject({ id, requests: 5 });
			} finally {
				await reopened.control.stopAll();
				reopened.team.stop();
			}
		} finally {
			await first.control.stopAll();
			first.team.stop();
		}
	});

	it("uses the original child budget when a fork explicitly resumes a recorded task", async () => {
		const first = setup();
		const input = { goal: "budget accounting", task: "budget loop 2" };
		try {
			const result = await first.run(input);
			const id = result.details.id;
			const entries = [
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
						details: { ...result.details, agentType: "task" },
					},
				},
			];
			first.team.stop();
			const fork = setup(first.ctx.cwd);
			Object.assign(fork.ctx.sessionManager, { getEntries: () => entries, getSessionId: () => "forked-budget-parent" });
			try {
				await fork.emit("session_start", { reason: "fork" }, fork.ctx);
				// Three saved replies, at the soft limit of 3: the resume counts them and gives a new allowance from there.
				const resumed = await fork.run({ goal: "continue accounting", task: "budget loop 40 stop-at 5", resume: id });
				expect(resumed.content[0].text).toContain("8 requests; limit 6");
				expect(resumed.content[0].text).toContain(`\`resume: ${id}\``);
				expect(resumed.details).toMatchObject({ id, requests: 5 });
			} finally {
				await fork.control.stopAll();
				fork.team.stop();
			}
		} finally {
			await first.control.stopAll();
			first.team.stop();
		}
	});

	it("counts a relayed peer's message as no grant, while the parent's own message or forward of one is", async () => {
		const parent = setup();
		/** What `team/relay.ts` and a forward call: the parent's process asks, with the stored message. */
		const resume = (id: string, message: Record<string, unknown>) =>
			(parent.team as unknown as { resumer: (...args: unknown[]) => Promise<string | undefined> }).resumer(
				id,
				"budget loop 40",
				parent.team.join().id,
				undefined,
				{ message: { id: 1, to: id, text: "budget loop 40 stop-at 5", at: Date.now(), ...message } },
			);
		try {
			const started = await parent.run({ task: "budget loop 40 stop-at 5", background: true });
			const id = started.details.id;
			await parent.control.settle();
			expect(parent.sent.at(-1)?.message.content).toContain("5 requests; limit 3");
			// A peer's message: at the hard limit it runs nothing, and the report says how to continue.
			expect(await resume(id, { from: "a-peer" })).toContain("Resumed");
			await parent.control.settle();
			const relayed = parent.sent.at(-1)?.message;
			expect(relayed?.content).toContain("5 requests; limit 3");
			expect(relayed?.content).toContain(`\`resume: ${id}\``);
			// No requests in this run: the details carry no count for it.
			expect(relayed?.details.id).toBe(id);
			expect(relayed?.details.requests ?? 0).toBe(0);
			// The parent forwarding that message decided it: a whole allowance from the five saved replies.
			expect(await resume(id, { from: "a-peer", forwardedBy: parent.team.join().id })).toContain("Resumed");
			await parent.control.settle();
			const forwarded = parent.sent.at(-1)?.message;
			expect(forwarded?.content).toContain("10 requests; limit 8");
			expect(forwarded?.details).toMatchObject({ id, requests: 5 });
		} finally {
			await parent.control.stopAll();
			parent.team.stop();
		}
	});

	it("refuses a message resume after its transcript disappears and releases the claimed slot", async () => {
		const parent = setup();
		try {
			const started = await parent.run({ task: "budget loop 2", background: true });
			await parent.control.settle();
			const id = started.details.id;
			fs.rmSync(childSessionFile(started.details.session as ChildSession)!);
			const reports = parent.sent.length;
			await expect(parent.team.send(id, "budget loop 40", { replyRequired: false })).rejects.toThrow(
				"saved transcript is missing",
			);
			await parent.control.settle();
			expect(parent.sent).toHaveLength(reports);
			expect(parent.control.background()).toBe(0);
			expect((await parent.run({ task: "budget loop 0" })).content[0].text).toContain("done: finished the loop");
		} finally {
			await parent.control.stopAll();
			parent.team.stop();
		}
	});
});
