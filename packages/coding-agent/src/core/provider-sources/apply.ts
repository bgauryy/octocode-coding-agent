import type { ModelRuntime } from "../model-runtime.ts";
import { providerSourceGate } from "./gate.ts";

/**
 * Make `overrides` (the `providerSources` setting) the sources in effect and recompute what the runtime offers:
 * Pi's credentials and models.json, and the Copilot variable, enter or leave availability without touching any file.
 * Call it at session start and after a settings reload; `/providers` calls it after a toggle.
 */
export async function applyProviderSources(runtime: ModelRuntime, overrides: unknown): Promise<void> {
	providerSourceGate.set(overrides);
	await runtime.refresh({ allowNetwork: false });
}
