import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startEndpoint } from "./e2e-real-process-harness.ts";

afterEach(() => vi.restoreAllMocks());

describe("scripted endpoint startup", () => {
	it("rejects a refused socket bind instead of leaving setup pending", async () => {
		const refused = Object.assign(new Error("listen EPERM: operation not permitted"), { code: "EPERM" });
		const server = http.createServer();
		const listeners = server.listeners("listening");
		vi.spyOn(http, "createServer").mockReturnValue(server);
		vi.spyOn(server, "listen").mockImplementation(() => {
			queueMicrotask(() => server.emit("error", refused));
			return server;
		});
		// Observe the mock's error independently so the old implementation demonstrates its pending promise.
		server.on("error", () => undefined);
		const settled = startEndpoint().then(
			() => ({ kind: "listening" }),
			(error: unknown) => ({ kind: "rejected", error }),
		);
		let deadline: NodeJS.Timeout | undefined;
		try {
			const result = await Promise.race([
				settled,
				new Promise((resolve) => {
					deadline = setTimeout(() => resolve({ kind: "pending" }), 100);
				}),
			]);
			expect(result).toEqual({ kind: "rejected", error: refused });
		} finally {
			clearTimeout(deadline);
		}
		expect(server.listeners("listening")).toEqual(listeners);
	});

	it("returns a listening endpoint without retaining startup listeners", async () => {
		const server = http.createServer();
		const listeners = server.listeners("listening");
		vi.spyOn(http, "createServer").mockReturnValue(server);
		vi.spyOn(server, "listen").mockImplementation(() => {
			queueMicrotask(() => server.emit("listening"));
			return server;
		});
		vi.spyOn(server, "address").mockReturnValue({ address: "127.0.0.1", family: "IPv4", port: 12345 });
		const endpoint = await startEndpoint();
		expect(endpoint.url).toBe("http://127.0.0.1:12345/v1");
		expect(server.listeners("listening")).toEqual(listeners);
		expect(server.listenerCount("error")).toBe(0);
		await endpoint.close();
	});
});
