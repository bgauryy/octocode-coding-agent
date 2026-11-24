import { setImmediate as nextTick } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { carryCustomReceipt, recordCustomMessage } from "../../../src/core/agent-session/custom-receipt.ts";
import type { CustomMessage } from "../../../src/core/messages.ts";
import { MemoryEventStore } from "../../../src/octocode/events/loop/store.ts";
import { WakeGate } from "../../../src/octocode/wake/gate.ts";
import { sessionPhaseOf } from "../../../src/octocode/shared/session-phase.ts";
import { installLive } from "../../../src/octocode/wake/live-host.ts";
import { fakeCtx, fakeHost } from "../fake-host.ts";

async function setup(size: number) {
	const host = fakeHost({ runtime: { eventWindowSeconds: 10 } });
	const store = new MemoryEventStore();
	const ctx = { ...fakeCtx({ cwd: "." }), sessionManager: SessionManager.inMemory() };
	const gate = new WakeGate(host.api);
	const failures: unknown[] = [];
	const live = installLive(host.api, gate, {
		store: ({ sessionManager }) =>
			sessionManager.getSessionId() === ctx.sessionManager.getSessionId() ? store : new MemoryEventStore(),
		failed: (error) => failures.push(error),
	});
	await host.fire("session_start", {}, ctx);
	live.loop()!.compactionStarted();
	const sent: Array<{ id: string; wake: boolean }> = [];
	const model = Promise.withResolvers<void>();
	vi.spyOn(host.api.session, "sendMessage").mockImplementation((msg, options) => {
		const entry: CustomMessage = { ...msg, role: "custom", timestamp: Date.now() };
		carryCustomReceipt(msg, entry);
		recordCustomMessage(ctx.sessionManager, entry);
		sent.push({ id: msg.customType, wake: options?.triggerTurn === true });
		return model.promise;
	});
	const ids = Array.from({ length: size }, (_, i) => `job-${i}`);
	const enqueue = (job: string) =>
		gate.emit(
			{ kind: "job.exit", job, exit: 0, durationMs: 1, startedAt: 0 },
			{ customType: job, content: job, display: true },
			{ triggerTurn: true },
		);
	for (const job of ids) await enqueue(job);
	return { host, store, ctx, live, sent, ids, failures, model, enqueue, gate };
}

it("hands a small batch to the transcript in the same tick", async () => {
	const { live, sent, ids, model, store } = await setup(3);
	live.loop()!.compactionEnded();
	expect(sent.map(({ id }) => id)).toEqual(ids);
	expect(sent.filter(({ wake }) => wake).map(({ id }) => id)).toEqual([ids.at(-1)]);
	expect(store.unread()).toHaveLength(0);
	model.resolve();
});

it.each(["idle", "input", "stop", "shutdown"] as const)(
	"services a heartbeat during a large %s handoff",
	async (action) => {
		const { host, ctx, live, sent, ids, failures, model, store, enqueue } = await setup(256);
		const heartbeat = nextTick().then(async () => {
			const progress = sent.length;
			if (action === "input") await host.fire("input", { text: "hello", source: "terminal" }, ctx);
			if (action === "stop" || action === "shutdown") {
				const arrivals = Array.from({ length: 80 }, (_, i) => `late-${i}`);
				for (const job of arrivals) await enqueue(job);
				ids.push(...arrivals);
			}
			if (action === "stop") live.loop()!.settled(false, true);
			if (action === "shutdown") {
				await host.fire("session_shutdown", {}, ctx);
				expect(sent).toHaveLength(ids.length);
			}
			return progress;
		});
		live.loop()!.compactionEnded();
		const progress = await heartbeat;
		expect(progress).toBeGreaterThan(0);
		expect(progress).toBeLessThan(256);
		await vi.waitFor(() => expect(store.unread()).toHaveLength(0));
		expect(sent.map(({ id }) => id)).toEqual(ids);
		expect(sent.filter(({ wake }) => wake).map(({ id }) => id)).toEqual(action === "idle" ? [ids.at(-1)] : []);
		expect(failures).toEqual([]);
		model.resolve();
	},
);

it("resumes only the unsent tail when a session is rebound during handoff", async () => {
	const { host, ctx, live, sent, ids, failures, model, store } = await setup(256);
	const heartbeat = nextTick().then(async () => {
		const progress = sent.length;
		await host.fire("session_start", {}, ctx);
		return progress;
	});
	live.loop()!.compactionEnded();
	const prefix = await heartbeat;
	expect(prefix).toBeGreaterThan(0);
	expect(prefix).toBeLessThan(ids.length);
	await nextTick();
	expect(sent).toHaveLength(prefix);
	// The rebound session owes the tail: its status shows a wake about to resume it.
	expect(sessionPhaseOf(host.api).factsNow().wakes).toHaveLength(1);
	await host.fire("session_shutdown", {}, ctx);
	expect(sent.map(({ id }) => id)).toEqual(ids);
	expect(sent.some(({ wake }) => wake)).toBe(false);
	expect(store.unread()).toHaveLength(0);
	expect(failures).toEqual([]);
	model.resolve();
});

it("clears outgoing wake indicators when another session opens during a shutdown handoff", async () => {
	const { host, ctx, live, gate, sent, ids, failures, model } = await setup(256);
	const replacement = { ...ctx, sessionManager: SessionManager.inMemory() };
	const pulse = nextTick().then(async () => {
		const count = sent.length;
		const closing = host.fire("session_shutdown", {}, ctx);
		await host.fire("session_start", {}, replacement);
		await closing;
		return count;
	});
	live.loop()!.compactionEnded();
	const count = await pulse;
	expect(count).toBeLessThan(ids.length);
	expect(sent).toHaveLength(count);
	expect(sessionPhaseOf(host.api).phase().state).toBe("idle");
	gate.segmentStarted(true);
	expect(host.entries).toEqual([]);
	expect(failures).toEqual([]);
	model.resolve();
});
