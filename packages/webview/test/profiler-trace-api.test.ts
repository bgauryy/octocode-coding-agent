/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createProfilerApi } from "../src/app/live/profiler-api.ts";

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

it("rejects a refused export instead of saving the error body", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("no", { status: 401 })),
	);
	await expect(createProfilerApi("bad").profilerTrace()).rejects.toThrow("HTTP 401");
});
