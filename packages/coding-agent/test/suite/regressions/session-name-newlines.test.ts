import { afterEach, describe, expect, it } from "vitest";
import type { FeatureSetup } from "../../../src/core/features/index.ts";
import { createHarness, type Harness } from "../harness.ts";
import { testFeatures } from "../../helpers/features.ts";

describe("session names do not contain newlines", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("filters newlines when AgentSession.setSessionName is called", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.setSessionName("hello\nworld\r\nagain");

		expect(harness.sessionManager.getSessionName()).toBe("hello world again");
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["hello world again"]);
	});

	it("filters newlines when an extension calls api.session.setName", async () => {
		let api: FeatureSetup | undefined;
		const harness = await createHarness({
			features: testFeatures([
				(host) => {
					api = host;
				},
			]),
		});
		harnesses.push(harness);

		api?.session.setName("from\nextension");

		expect(harness.sessionManager.getSessionName()).toBe("from extension");
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["from extension"]);
	});
});
