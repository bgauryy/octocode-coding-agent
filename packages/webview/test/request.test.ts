import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestJson } from "../src/request.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function stalled(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) =>
		signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
	);
}

it("times out stalled requests without resending a mutation", async () => {
	const fetch = vi.fn((_url, options: RequestInit) => stalled(options.signal!));
	vi.stubGlobal("fetch", fetch);
	const request = requestJson("/api/backlogs", { method: "POST", body: "draft" });
	const failed = expect(request).rejects.toThrow("Request timed out. Check the current state before retrying.");
	await vi.advanceTimersByTimeAsync(15_000);
	await failed;
	expect(fetch).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

it("keeps the timeout active until the response body finishes", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, options: RequestInit) => ({
			ok: true,
			json: () => stalled(options.signal!),
		})),
	);
	const failed = expect(requestJson("/api/backlogs")).rejects.toThrow("Request timed out");
	await vi.advanceTimersByTimeAsync(15_000);
	await failed;
});

it("preserves caller cancellation and clears timers after success or server errors", async () => {
	const fetch = vi.fn((_url, options: RequestInit) => stalled(options.signal!));
	vi.stubGlobal("fetch", fetch);
	const controller = new AbortController();
	const request = requestJson("/api/reports", { signal: controller.signal });
	const failed = expect(request).rejects.toThrow("View closed");
	controller.abort(new Error("View closed"));
	await failed;
	expect(vi.getTimerCount()).toBe(0);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => ({ saved: true }) })),
	);
	await expect(requestJson("/api/backlogs")).resolves.toEqual({ saved: true });
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: false, json: async () => ({ error: "Item changed" }) })),
	);
	await expect(requestJson("/api/backlogs")).rejects.toThrow("Item changed");
	expect(vi.getTimerCount()).toBe(0);
});
