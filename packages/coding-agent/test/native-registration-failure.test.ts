import { createEventBus } from "@octocodeai/octocode-agent-core";
import { describe, expect, it } from "vitest";
import type { Feature } from "../src/core/features/types.ts";
import { FeatureSetLoader, type FeatureLoadingConfig } from "../src/core/resource-loader/feature-loading.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { testFeature } from "./helpers/features.ts";

function loader(nativeFeature: Feature, injected: Feature[] = []): FeatureSetLoader {
	return new FeatureSetLoader({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		settingsManager: SettingsManager.inMemory(),
		eventBus: createEventBus(),
		builtinFeatures: [],
		nativeFeature,
		injected,
		disabledFeatures: new Set(),
	} as unknown as FeatureLoadingConfig);
}

const failing = (message: string) => () => {
	throw new Error(message);
};

describe("feature registration failures", () => {
	it("fails startup when the native feature set fails to register", async () => {
		const native: Feature = { id: "octocode", owner: "native", register: failing("no permission store") };
		await expect(loader(native).loadFeatures()).rejects.toThrow(/no permission store/);
	});

	it("reports and skips a failed non-native feature, keeping the rest", async () => {
		const native: Feature = { id: "octocode", owner: "native", register: () => {} };
		const result = await loader(native, [
			testFeature("broken", failing("bad config")),
			testFeature("fine", () => {}),
		]).loadFeatures();
		expect(result.errors).toEqual([{ path: "<inline:broken>", error: "bad config" }]);
		expect(result.features.map((feature) => feature.id)).toEqual(["octocode", "fine"]);
	});
});
