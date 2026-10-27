import { afterEach, describe, expect, it, vi } from "vitest";
import { VERIFY_NUDGE, VERIFY_NUDGE_TYPE, registerVerifyNudge } from "../../src/octocode/files/verify-nudge.ts";
import { beginVerification, finishVerification } from "../../src/octocode/files/bash/verification.ts";
import { recordMutation } from "../../src/octocode/files/feedback/revisions.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";

afterEach(() => vi.unstubAllEnvs());

let counter = 0;
function run() {
	const sessionId = `nudge-${++counter}`;
	const fake = fakePi();
	registerVerifyNudge(fake.pi);
	const ctx = fakeCtx({ cwd: "/repo" });
	Object.assign(ctx, { sessionManager: { getSessionId: () => sessionId } });
	const settle = async (entries: unknown[] = [], outcome = "completed") =>
		(await fake.emit("agent_before_settle", { outcome, entries, context: { llmMessages: [] } }, ctx)).find(
			(value) => value !== undefined,
		) as { continue?: boolean; entries?: Array<{ customType: string; content: string }> } | undefined;
	const check = (code = 0) => {
		const receipt = beginVerification("yarn test", "/repo", sessionId);
		finishVerification(receipt, { code, signal: null, seconds: 1 });
	};
	return { sessionId, start: () => fake.fire("before_agent_start", {}, ctx), settle, check };
}

describe("verify before settle", () => {
	it("nudges once when files changed and no passing check ran", async () => {
		const { sessionId, start, settle } = run();
		await start();
		recordMutation(sessionId);
		const first = await settle();
		expect(first).toMatchObject({
			continue: true,
			entries: [{ customType: VERIFY_NUDGE_TYPE, content: VERIFY_NUDGE }],
		});
		expect(await settle()).toBeUndefined();
	});

	it("does not nudge a run without file edits, nor one whose edit a later check covered", async () => {
		const { sessionId, start, settle, check } = run();
		await start();
		expect(await settle()).toBeUndefined();
		recordMutation(sessionId);
		check();
		expect(await settle()).toBeUndefined();
	});

	it("nudges again when an edit follows the passing check, or the check failed", async () => {
		const { sessionId, start, settle, check } = run();
		await start();
		recordMutation(sessionId);
		check();
		recordMutation(sessionId);
		expect(await settle()).toMatchObject({ continue: true });
		await start();
		recordMutation(sessionId);
		check(1);
		expect(await settle()).toMatchObject({ continue: true });
	});

	it("counts a mutating shell command as staling a check, but not as a file edit", async () => {
		const { sessionId, start, settle, check } = run();
		await start();
		recordMutation(sessionId, "bash");
		expect(await settle()).toBeUndefined();
		recordMutation(sessionId);
		check();
		recordMutation(sessionId, "bash");
		expect(await settle()).toMatchObject({ continue: true });
	});

	it("is spent per run: a new prompt may nudge again, edits of an earlier run do not count", async () => {
		const { sessionId, start, settle } = run();
		await start();
		recordMutation(sessionId);
		expect(await settle()).toMatchObject({ continue: true });
		await start();
		expect(await settle()).toBeUndefined();
		recordMutation(sessionId);
		expect(await settle()).toMatchObject({ continue: true });
	});

	it("stays out of the way of failed or aborted runs, another continuation, and read-only roles", async () => {
		const { sessionId, start, settle } = run();
		await start();
		recordMutation(sessionId);
		expect(await settle([], "error")).toBeUndefined();
		expect(await settle([], "aborted")).toBeUndefined();
		expect(await settle([{ type: "custom_message" }])).toBeUndefined();
		vi.stubEnv("OCTOCODE_SUBAGENT", "1");
		vi.stubEnv("OCTOCODE_READ_ONLY", "1");
		expect(await settle()).toBeUndefined();
		vi.unstubAllEnvs();
		expect(await settle()).toMatchObject({ continue: true });
	});
});
