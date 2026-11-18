import { describe, expect, it } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { createFeatureRuntime, loadFeatureFromFactory } from "../../helpers/features.ts";
import type { FeatureSetup, ProviderConfig } from "../../../src/core/features/types.ts";

const providerConfig = {
	baseUrl: "https://provider.test/v1",
	apiKey: "provider-test-key",
} satisfies ProviderConfig;

describe("extension factory failure", () => {
	it("discards runtime changes and disables the failed API", async () => {
		const runtime = createFeatureRuntime();
		const eventBus = createEventBus();
		let capturedApi: FeatureSetup | undefined;
		let eventCalls = 0;

		await loadFeatureFromFactory(
			(api) => api.providers.register("working-provider", providerConfig),
			process.cwd(),
			eventBus,
			runtime,
			"<working>",
		);
		await expect(
			loadFeatureFromFactory(
				(api) => {
					capturedApi = api;
					api.channels.on("factory-failure", () => {
						eventCalls++;
					});
					api.providers.register("failed-provider", providerConfig);
					throw new Error("factory failed");
				},
				process.cwd(),
				eventBus,
				runtime,
				"<failing>",
			),
		).rejects.toThrow("factory failed");

		eventBus.emit("factory-failure", undefined);
		expect(runtime.pendingProviderRegistrations.map(({ name }) => name)).toEqual(["working-provider"]);
		expect(eventCalls).toBe(0);
		expect(capturedApi).toBeDefined();
		expect(() => capturedApi?.providers.register("late-provider", providerConfig)).toThrow(
			'Feature "<failing>" failed to register and its setup is no longer active.',
		);
	});

	it("does not discard a concurrently loaded factory's provider", async () => {
		const runtime = createFeatureRuntime();
		const eventBus = createEventBus();
		let releaseFailure!: () => void;
		const waitBeforeFailure = new Promise<void>((resolve) => {
			releaseFailure = resolve;
		});
		const failingLoad = loadFeatureFromFactory(
			async (api) => {
				api.providers.register("failed-provider", providerConfig);
				await waitBeforeFailure;
				throw new Error("factory failed");
			},
			process.cwd(),
			eventBus,
			runtime,
			"<failing>",
		);

		await loadFeatureFromFactory(
			(api) => api.providers.register("working-provider", providerConfig),
			process.cwd(),
			eventBus,
			runtime,
			"<working>",
		);
		releaseFailure();

		await expect(failingLoad).rejects.toThrow("factory failed");
		expect(runtime.pendingProviderRegistrations.map(({ name }) => name)).toEqual(["working-provider"]);
	});
});
