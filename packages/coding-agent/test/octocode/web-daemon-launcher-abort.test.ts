import { describe, expect, it } from "vitest";
import { type LaunchedDaemon, waitForSession } from "../../src/octocode/web-daemon/launcher.ts";

describe("waitForSession", () => {
	it("stops polling when its signal aborts instead of waiting out the deadline", async () => {
		// Nothing listens on port 1, so each poll fails fast and the wait is the sleep between polls.
		const daemon = { origin: "http://127.0.0.1:1", token: "t", record: {} } as unknown as LaunchedDaemon;
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const started = Date.now();
		await expect(waitForSession(daemon, "s", 10_000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});
