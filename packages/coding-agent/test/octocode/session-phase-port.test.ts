import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { getApplicationPort } from "../../src/core/application/index.ts";
import { runningWorkOf } from "../../src/octocode/shared/running-work.ts";
import { registerPhaseFeed } from "../../src/octocode/ui/phase-feed.ts";
import { applicationPhaseOf } from "../../src/octocode/ui/phase-port.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("the session phase reaches the application port", () => {
	it("publishes waiting after a run settles with a background child, and done when it drains", async () => {
		vi.useFakeTimers({ now: 10_000 });
		const fake = fakeHost();
		const session = {
			sessionId: "session-test",
			messages: [],
			isStreaming: false,
			subscribe: () => () => {},
		} as unknown as AgentSession;
		const port = getApplicationPort(session);
		const ctx = fakeCtx({ cwd: "/x" });
		registerPhaseFeed(fake.api);
		await fake.emit("session_start", {}, ctx);
		expect(port.getSnapshot().phase).toEqual({ state: "idle" });

		await fake.emit("agent_start", {}, ctx);
		expect(port.getSnapshot()).toMatchObject({ phase: { state: "working" }, jobStartedAt: 10_000 });
		runningWorkOf(fake.api).setBackground(["kid"]);
		await fake.emit("agent_settled", { aborted: false }, ctx);
		expect(port.getSnapshot()).toMatchObject({
			phase: { state: "waiting", agents: 1, queued: 0, bash: 0, external: 0 },
			jobStartedAt: 10_000,
		});

		runningWorkOf(fake.api).setBackground([]);
		const done = port.getSnapshot();
		expect(done.phase).toEqual({ state: "done" });
		expect("jobStartedAt" in done).toBe(false);
		port.dispose();
	});

	it("gives a port opened after the last phase change the current phase in its first snapshot", async () => {
		vi.useFakeTimers({ now: 10_000 });
		const fake = fakeHost();
		const session = {
			sessionId: "session-test",
			messages: [],
			isStreaming: false,
			subscribe: () => () => {},
		} as unknown as AgentSession;
		const ctx = fakeCtx({ cwd: "/x" });
		registerPhaseFeed(fake.api);
		await fake.emit("session_start", {}, ctx);
		await fake.emit("agent_start", {}, ctx);
		runningWorkOf(fake.api).setBackground(["kid"]);
		await fake.emit("agent_settled", { aborted: false }, ctx);
		// No port exists while the session waits: nothing was published anywhere.
		const port = getApplicationPort(session);
		expect(port.getSnapshot()).toMatchObject({
			phase: { state: "waiting", agents: 1 },
			jobStartedAt: 10_000,
		});
		port.dispose();
		await fake.emit("session_shutdown", {}, ctx);
	});

	it("redacts and bounds what a phase carries", () => {
		const phase = applicationPhaseOf({ state: "failed", error: `token ${"x".repeat(500)}`, open: ["B1"] });
		expect(phase).toMatchObject({ state: "failed", open: ["B1"] });
		expect((phase as { error: string }).error.length).toBeLessThanOrEqual(300);
		expect(applicationPhaseOf({ state: "blocked", title: "y".repeat(500) })).toMatchObject({ state: "blocked" });
		expect(
			(applicationPhaseOf({ state: "blocked", title: "y".repeat(500) }) as { title: string }).title.length,
		).toBeLessThanOrEqual(200);
	});
});
