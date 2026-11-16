import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { sessionMirrorSettled } from "../src/core/session-manager/mirror.ts";

vi.mock("../src/core/session-manager/mirror.ts", () => ({ sessionMirrorSettled: vi.fn(async () => {}) }));

afterEach(() => vi.clearAllMocks());

function fixture(failures: string[] = []) {
	const calls: string[] = [];
	const step = (name: string) => () => {
		calls.push(name);
		if (failures.includes(name)) throw new Error(name);
	};
	const session = {
		abort: async () => step("abort")(),
		extensionRunner: { hasHandlers: () => true, emit: async () => step("shutdown")() },
		sessionManager: { retire: step("retire") },
		dispose: step("session"),
	} as unknown as AgentSession;
	const services = { dispose: step("services") } as unknown as AgentSessionServices;
	const runtime = new AgentSessionRuntime(session, services, async () => {
		throw new Error("unused factory");
	});
	runtime.setBeforeSessionInvalidate(step("detach"));
	return { runtime, calls };
}

describe("session shutdown ownership", () => {
	it("shares one shutdown across concurrent and repeated dispose calls", async () => {
		const { runtime, calls } = fixture();
		const first = runtime.dispose();
		expect(runtime.dispose() === first).toBe(true);
		await first;
		await runtime.dispose();
		expect(calls).toEqual(["abort", "shutdown", "detach", "retire", "session", "services"]);
		expect(sessionMirrorSettled).toHaveBeenCalledExactlyOnceWith(1500);
	});

	it.each(["abort", "shutdown", "detach", "retire", "session", "services"])(
		"still releases all resources and drains writes when %s fails",
		async (phase) => {
			const { runtime, calls } = fixture([phase]);
			await expect(runtime.dispose()).rejects.toThrow(phase);
			expect(calls).toEqual(["abort", "shutdown", "detach", "retire", "session", "services"]);
			expect(sessionMirrorSettled).toHaveBeenCalledExactlyOnceWith(1500);
			await expect(runtime.dispose()).rejects.toThrow(phase);
			expect(calls).toHaveLength(6);
		},
	);

	it("reports all cleanup errors after attempting every phase", async () => {
		const { runtime, calls } = fixture(["abort", "detach", "services"]);
		const error = await runtime.dispose().catch((error: unknown) => error);
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors.map((error: Error) => error.message)).toEqual([
			"abort",
			"detach",
			"services",
		]);
		expect(calls).toHaveLength(6);
		expect(sessionMirrorSettled).toHaveBeenCalledOnce();
	});

	it("continues disposing when abort never settles", async () => {
		vi.useFakeTimers();
		try {
			const { runtime, calls } = fixture();
			(runtime.session as unknown as { abort: () => Promise<void> }).abort = () => new Promise(() => {});
			const done = runtime.dispose();
			await vi.advanceTimersByTimeAsync(4_999);
			expect(calls).toEqual([]);
			await vi.advanceTimersByTimeAsync(1);
			await done;
			expect(calls).toEqual(["shutdown", "detach", "retire", "session", "services"]);
		} finally {
			vi.useRealTimers();
		}
	});
});
