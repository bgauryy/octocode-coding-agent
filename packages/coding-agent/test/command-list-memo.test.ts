import { expect, it } from "vitest";
import { createHarness } from "./suite/harness.ts";
import { testFeatures } from "./helpers/features.ts";
import type { FeatureSetup } from "../src/core/features/types.ts";
import { cleanTitle } from "../src/core/session-manager/title.ts";

it("keeps the command list while nothing changes and shows a command registered later at once", async () => {
	let api: FeatureSetup | undefined;
	const harness = await createHarness({
		features: testFeatures([
			(featureApi) => {
				api = featureApi;
				featureApi.commands.register("first", { handler: async () => {} });
			},
		]),
	});
	try {
		const runner = harness.session.featureHost;
		const before = runner.getRegisteredCommands();
		expect(runner.getRegisteredCommands()).toBe(before);
		const names = () => api!.resources.getCommands().map((command) => command.name);
		expect(names()).toContain("first");
		expect(names()).not.toContain("later");

		api!.commands.register("later", { handler: async () => {} });
		expect(runner.getRegisteredCommands()).not.toBe(before);
		expect(runner.getCommand("later")).toBeDefined();
		expect(names()).toContain("later");

		api!.commands.register("later", { description: "again", handler: async () => {} });
		const later = api!.resources.getCommands().find((command) => command.name === "later");
		expect(later?.description).toBe("again");
	} finally {
		harness.cleanup();
	}
});

it("answers each title from its own text", () => {
	expect(cleanTitle("hello   world")).toBe("hello world");
	expect(cleanTitle("hello   world", 5)).toBe("hell…");
	expect(cleanTitle("other")).toBe("other");
});
