import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_RESULT_TYPE } from "../../src/octocode/shared/messages.ts";
import { STATUS } from "../../src/octocode/shared/status.ts";
import { registerWakeRetry, WAKE_RETRY_MS } from "../../src/octocode/wake-retry.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const failed = (errorMessage = "503 Service Unavailable") => ({
	type: "agent_settled",
	aborted: false,
	outcome: { status: "failed", stopReason: "error", errorMessage, usage: {} },
});
const woken = (customType = AGENT_RESULT_TYPE) => ({
	type: "before_agent_start",
	messageType: "custom",
	message: { customType },
});

function setup(isSubagent = false, hasUI = true) {
	const fake = fakeHost();
	registerWakeRetry(fake.api, isSubagent);
	const ctx = fakeCtx({ cwd: "/x", hasUI });
	return { ...fake, ctx };
}

describe("re-waking after a failed wake turn", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("tries again at each growing wait with a visible status, then stops with a notice", async () => {
		const t = setup();
		await t.emit("before_agent_start", woken(), t.ctx);
		await t.emit("agent_settled", failed(), t.ctx);
		for (const [index, wait] of WAKE_RETRY_MS.entries()) {
			// A clock time, which stays true for the whole wait (a written-once "in 30m" would look frozen).
			const due = new Date(Date.now() + wait).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			});
			expect(t.ctx.ui.statuses.get(STATUS.wakeRetry)).toContain(`retrying at ${due}`);
			await vi.advanceTimersByTimeAsync(wait - 1);
			expect(t.sent).toHaveLength(index);
			await vi.advanceTimersByTimeAsync(1);
			expect(t.sent).toHaveLength(index + 1);
			expect(t.sent[index].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
			await t.emit("before_agent_start", woken(t.sent[index].message.customType), t.ctx);
			await t.emit("agent_settled", failed(), t.ctx);
		}
		expect(t.ctx.ui.statuses.get(STATUS.wakeRetry)).toBeUndefined();
		expect(t.ctx.ui.notes.at(-1)).toMatchObject({ type: "warning", message: expect.stringContaining("503") });
		await vi.advanceTimersByTimeAsync(WAKE_RETRY_MS.at(-1)! * 2);
		expect(t.sent).toHaveLength(WAKE_RETRY_MS.length);
	});

	it("is cancelled by a user's prompt and by any input", async () => {
		const t = setup();
		await t.emit("before_agent_start", woken(), t.ctx);
		await t.emit("agent_settled", failed(), t.ctx);
		await t.emit("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "hi" }, t.ctx);
		expect(t.ctx.ui.statuses.get(STATUS.wakeRetry)).toBeUndefined();
		await vi.advanceTimersByTimeAsync(WAKE_RETRY_MS[0]);
		expect(t.sent).toHaveLength(0);

		await t.emit("before_agent_start", woken(), t.ctx);
		await t.emit("agent_settled", failed(), t.ctx);
		await t.emit("input", { type: "input", text: "/help" }, t.ctx);
		await vi.advanceTimersByTimeAsync(WAKE_RETRY_MS[0]);
		expect(t.sent).toHaveLength(0);
	});

	it("starts the waits over after a wake that succeeds", async () => {
		const t = setup();
		await t.emit("before_agent_start", woken(), t.ctx);
		await t.emit("agent_settled", failed(), t.ctx);
		await vi.advanceTimersByTimeAsync(WAKE_RETRY_MS[0]);
		await t.emit("before_agent_start", woken(t.sent[0].message.customType), t.ctx);
		await t.emit("agent_settled", { type: "agent_settled", aborted: false, outcome: { status: "completed" } }, t.ctx);
		await t.emit("before_agent_start", woken(), t.ctx);
		await t.emit("agent_settled", failed(), t.ctx);
		expect(t.ctx.ui.statuses.get(STATUS.wakeRetry)).toContain("retrying at ");
	});

	it("does nothing for a user's failed run, an error waiting cannot clear, a subagent or a headless run", async () => {
		const user = setup();
		await user.emit("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "hi" }, user.ctx);
		await user.emit("agent_settled", failed(), user.ctx);

		const permanent = setup();
		await permanent.emit("before_agent_start", woken(), permanent.ctx);
		await permanent.emit("agent_settled", failed("401 invalid x-api-key"), permanent.ctx);

		const child = setup(true);
		await child.emit("before_agent_start", woken(), child.ctx);
		await child.emit("agent_settled", failed(), child.ctx);

		const headless = setup(false, false);
		await headless.emit("before_agent_start", woken(), headless.ctx);
		await headless.emit("agent_settled", failed(), headless.ctx);

		await vi.advanceTimersByTimeAsync(WAKE_RETRY_MS[0]);
		for (const t of [user, permanent, child, headless]) expect(t.sent).toHaveLength(0);
	});
});
