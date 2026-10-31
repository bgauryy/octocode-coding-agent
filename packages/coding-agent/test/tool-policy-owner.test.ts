import { expect, it, vi } from "vitest";
import { nativeHost } from "../src/octocode/shared/host-api.ts";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
it("does not let a general extension replace native tool permission policy", async () => {
	const runtime = createExtensionRuntime();
	runtime.setToolPolicy = vi.fn();
	await expect(
		loadExtensionFromFactory(
			(api) => {
				nativeHost(api).setToolPolicy!(() => true);
			},
			process.cwd(),
			createEventBus(),
			runtime,
		),
	).rejects.toThrow("owned by native features");
	expect(runtime.setToolPolicy).not.toHaveBeenCalled();
});
