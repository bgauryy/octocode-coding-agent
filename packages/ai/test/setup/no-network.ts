import { beforeEach, vi } from "vitest";
const originalFetch = globalThis.fetch;
beforeEach(() => {
	vi.stubGlobal("fetch", async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
			throw new Error(`network blocked in tests: ${url.href}`);
		return originalFetch(input, init);
	});
});
