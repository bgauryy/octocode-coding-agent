import { expect, it, vi } from "vitest";
import { nativeHost } from "../src/octocode/shared/host-api.ts";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { createFeatureRuntime, loadFeatureFromFactory } from "./helpers/features.ts";
it("does not let a general extension replace native tool permission policy", async () => {
	const runtime = createFeatureRuntime();
	runtime.setToolPolicy = vi.fn();
	await expect(
		loadFeatureFromFactory(
			(api) => {
				nativeHost(api).tools.setPolicy!(() => true);
			},
			process.cwd(),
			createEventBus(),
			runtime,
		),
	).rejects.toThrow("owned by native features");
	expect(runtime.setToolPolicy).not.toHaveBeenCalled();
});
