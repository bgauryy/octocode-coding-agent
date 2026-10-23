import { expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
} from "../src/core/extensions/loader.ts";
it("does not let a general extension replace native tool permission policy", async () => {
	const runtime = createExtensionRuntime();
	runtime.setToolPolicy = vi.fn();
	await expect(
		loadExtensionFromFactory(
			(pi) => {
				pi.setToolPolicy!(() => true);
			},
			process.cwd(),
			createEventBus(),
			runtime,
		),
	).rejects.toThrow("owned by native features");
	expect(runtime.setToolPolicy).not.toHaveBeenCalled();
});
