import { beforeAll } from "vitest";

/**
 * The product default (12 requests per session and provider per minute) would make any test that scripts more than 12
 * faux requests in a minute wait for the window. The harness runs with the limit off unless a test sets
 * `requestsPerMinute` itself; `request-rate.test.ts` drives the real limit through its own host.
 *
 * SettingsManager loads in `beforeAll`, after the test file's own imports and `vi.mock` calls: loading it from the setup
 * file would put the real modules into the cache before a test's mocks apply.
 */
beforeAll(async () => {
	const { SettingsManager } = await import("../../src/core/settings-manager.ts");
	const proto = SettingsManager.prototype as unknown as {
		getRequestsPerMinute(): number;
		settings: { requestsPerMinute?: number };
	};
	const product = proto.getRequestsPerMinute;
	proto.getRequestsPerMinute = function (this: typeof proto) {
		return this.settings.requestsPerMinute === undefined ? 0 : product.call(this);
	};
});
