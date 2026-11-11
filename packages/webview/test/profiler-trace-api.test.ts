/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createProfilerApi } from "../src/app/live/profiler-api.ts";
import { SIGN_IN_MESSAGE } from "../src/request.ts";

afterEach(() => vi.unstubAllGlobals());

it("fetches the trace with the bearer token and returns the file", async () => {
	const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
	vi.stubGlobal("fetch", fetchMock);
	const blob = await createProfilerApi("tok").profilerTrace();
	expect(await blob.text()).toBe("{}");
	const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
	expect(url).toContain("/profiler/trace");
	expect(init.headers).toEqual({ Authorization: "Bearer tok" });
});

it("rejects a refused export with the sign-in message instead of saving the error body", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("no", { status: 401 })),
	);
	await expect(createProfilerApi("bad").profilerTrace()).rejects.toThrow(SIGN_IN_MESSAGE);
});

it("bounds the export like every other request and names the failure", async () => {
	vi.useFakeTimers();
	try {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
			),
		);
		const stalled = expect(createProfilerApi("tok").profilerTrace()).rejects.toThrow("Request timed out");
		await vi.advanceTimersByTimeAsync(15_000);
		await stalled;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })),
		);
		await expect(createProfilerApi("tok").profilerTrace()).rejects.toThrow("Could not export the trace");
	} finally {
		vi.useRealTimers();
	}
});
