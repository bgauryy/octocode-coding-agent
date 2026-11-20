import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_OFFLINE_INTERVAL_MS,
	isNetworkFailureText,
	mayRetry,
	mayRetryOffline,
	planOfflineRetry,
} from "../src/utils/retry.ts";

const PROBE = "OCTOCODE_NETWORK_PROBE";
const saved = process.env[PROBE];

afterEach(() => {
	process.env[PROBE] = saved;
});

const ENOTFOUND = "fetch failed (ENOTFOUND)";

describe("offline retry plan", () => {
	it("treats DNS and transport failures as possible outages, and provider refusals as not", () => {
		for (const text of [ENOTFOUND, "getaddrinfo ENOTFOUND api.x", "fetch failed (ECONNRESET)", "ENETUNREACH"]) {
			expect(isNetworkFailureText(text)).toBe(true);
		}
		for (const text of ["429 rate limit", "400 invalid_request_error", "overloaded"]) {
			expect(isNetworkFailureText(text)).toBe(false);
		}
	});

	it("waits a minute with no attempt cap while the machine is offline", async () => {
		process.env[PROBE] = "offline";
		const since = 1_000_000;
		const plan = await planOfflineRetry({}, ENOTFOUND, since, since + 3 * 60 * 60_000);
		expect(plan).toEqual({ kind: "wait", since, delayMs: DEFAULT_OFFLINE_INTERVAL_MS });
		expect(DEFAULT_OFFLINE_INTERVAL_MS).toBe(60_000);
	});

	it("leaves a failure to the bounded budget when the network works: a mistyped host is not an outage", async () => {
		process.env[PROBE] = "online";
		expect(await planOfflineRetry({}, "getaddrinfo ENOTFOUND api.example.invalid", 0)).toEqual({ kind: "online" });
		expect(mayRetry(4, 3, "getaddrinfo ENOTFOUND api.example.invalid", 0)).toBe(false);
	});

	it("never asks the network about a failure an outage cannot explain", async () => {
		process.env[PROBE] = "offline";
		expect(await planOfflineRetry({}, "429 rate limit", 0)).toEqual({ kind: "online" });
	});

	it("stops at offlineMaxMs and shortens the last wait to fit it", async () => {
		process.env[PROBE] = "offline";
		const policy = { offlineIntervalMs: 60_000, offlineMaxMs: 30 * 60_000 };
		expect(await planOfflineRetry(policy, ENOTFOUND, 0, 29 * 60_000 + 30_000)).toEqual({
			kind: "wait",
			since: 0,
			delayMs: 30_000,
		});
		expect(await planOfflineRetry(policy, ENOTFOUND, 0, 30 * 60_000)).toEqual({ kind: "stop", since: 0 });
		expect(mayRetryOffline(policy, 30 * 60_000)).toBe(false);
		expect(mayRetryOffline({ offlineMaxMs: 0 }, 1e12)).toBe(true);
	});

	it("uses the configured interval", async () => {
		process.env[PROBE] = "offline";
		const plan = await planOfflineRetry({ offlineIntervalMs: 5_000 }, ENOTFOUND, 0, 1);
		expect(plan).toEqual({ kind: "wait", since: 0, delayMs: 5_000 });
	});
});
