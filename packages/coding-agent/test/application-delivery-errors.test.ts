import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { ApplicationDelivery } from "../src/core/application/service/delivery.ts";
import { createApplicationState } from "../src/core/application/state.ts";

const event = { type: "agent_start" } as AgentSessionEvent;

function delivery(): ApplicationDelivery {
	const state = createApplicationState("s");
	return new ApplicationDelivery(state, () => ({}) as never);
}

describe("application listener failures", () => {
	afterEach(() => vi.restoreAllMocks());

	test("go to the subscriber's handler, not stderr, once per distinct failure", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const port = delivery();
		const seen: string[] = [];
		let calls = 0;
		port.subscribeNative(
			() => {
				calls++;
				throw new Error("draw failed");
			},
			(error) => seen.push((error as Error).message),
		);
		port.subscribeNative(
			async () => {
				throw new Error("async draw failed");
			},
			(error) => seen.push((error as Error).message),
		);
		for (let index = 0; index < 50; index++) port.notifyNative(event);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(calls).toBe(50);
		expect(seen).toEqual(["draw failed", "async draw failed"]);
		expect(stderr).not.toHaveBeenCalled();
	});

	test("a handler that re-enters the failing listener or throws does not recurse", () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const port = delivery();
		let reports = 0;
		port.subscribe(
			() => {
				throw new Error("render failed");
			},
			() => {
				reports++;
				// Showing the error publishes again, which reaches the same failing listener.
				port.notify({ type: "application.error", id: "e", code: "content-unavailable", message: "x" });
				throw new Error("handler failed");
			},
		);
		port.notify({ type: "application.error", id: "e", code: "content-unavailable", message: "x" });
		port.notify({ type: "application.error", id: "e", code: "content-unavailable", message: "x" });

		expect(reports).toBe(1);
		expect(stderr).toHaveBeenCalledTimes(1);
	});

	test("fall back to stderr without a handler, once per distinct failure", () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const port = delivery();
		port.subscribeNative(() => {
			throw new Error("no handler");
		});
		for (let index = 0; index < 10; index++) port.notifyNative(event);

		expect(stderr).toHaveBeenCalledTimes(1);
		expect(String(stderr.mock.calls[0]?.[0])).toContain("Application listener failed Error: no handler");
	});
});
