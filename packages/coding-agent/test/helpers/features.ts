import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEventBus, type EventBus } from "@octocodeai/octocode-agent-core";
import { registerFeature } from "../../src/core/features/register.ts";
import { createFeatureRuntime } from "../../src/core/features/runtime.ts";
import type {
	FeatureRecord,
	FeatureRegister,
	FeatureRuntime,
	Feature,
	LoadedFeatures,
} from "../../src/core/features/types.ts";
import type { FeatureOwner } from "../../src/core/source-info.ts";

export { createFeatureRuntime };

/** A feature a test composes next to the defaults; it is shown as `<inline:id>`. */
export function testFeature(id: string, register: Feature["register"], options: { hidden?: boolean } = {}): Feature {
	return { id, owner: "builtin", path: `<inline:${id}>`, register, ...(options.hidden ? { hidden: true } : {}) };
}

/** What `testFeatures` accepts: a feature, a bare register function, or one with a name, a path or an owner. */
export type TestFeatureInput =
	| Feature
	| Feature["register"]
	| { factory: Feature["register"]; name?: string; path?: string; owner?: FeatureOwner; hidden?: boolean };

/** Features from test inputs; a bare function is numbered by its place in the list, as `<inline:1>`. */
export function testFeatures(inputs: readonly TestFeatureInput[]): Feature[] {
	return inputs.map((input, index) => {
		if (typeof input === "function") return testFeature(String(index + 1), input);
		if ("register" in input) return input;
		const feature = testFeature(input.name ?? String(index + 1), input.factory, { hidden: input.hidden });
		// A name names the source; a path stands in only without one.
		const path = input.name === undefined && input.path ? { path: input.path } : {};
		return { ...feature, ...path, owner: input.owner ?? "builtin" };
	});
}

/** Register one factory as a feature, as the resource loader does, and return its registrations. */
export function loadFeatureFromFactory(
	factory: FeatureRegister,
	cwd: string,
	eventBus: EventBus,
	runtime: FeatureRuntime,
	path = "<inline>",
	owner: FeatureOwner = "builtin",
): Promise<FeatureRecord> {
	return registerFeature({ id: path, owner, path, register: factory }, eventBus, runtime);
}

/**
 * Register feature modules from files, for tests that exercise the runner with fixture modules. The product never
 * loads files; this helper imports each module's default export and registers it as a feature.
 */
export async function loadFeatures(
	paths: string[],
	cwd: string,
	eventBus: EventBus = createEventBus(),
	runtime: FeatureRuntime = createFeatureRuntime(),
): Promise<LoadedFeatures> {
	const result: LoadedFeatures = { features: [], errors: [], warnings: [], runtime };
	for (const file of paths) {
		try {
			const factory = (await import(pathToFileURL(file).href)).default as FeatureRegister;
			if (typeof factory !== "function") {
				result.errors.push({ path: file, error: `Feature does not export a valid factory function: ${file}` });
				continue;
			}
			result.features.push(await loadFeatureFromFactory(factory, cwd, eventBus, runtime, file));
		} catch (error) {
			result.errors.push({
				path: file,
				error: `Failed to load feature: ${error instanceof Error ? error.message : error}`,
			});
		}
	}
	return result;
}

/** `loadFeatures` for the `*.ts` files directly in `<agentDir>/features/`. */
export function discoverAndLoadFeatures(_configured: string[], cwd: string, agentDir: string): Promise<LoadedFeatures> {
	const dir = join(agentDir, "features");
	const files = existsSync(dir)
		? readdirSync(dir)
				.filter((name) => name.endsWith(".ts"))
				.sort()
				.map((name) => join(dir, name))
		: [];
	return loadFeatures(files, cwd);
}
