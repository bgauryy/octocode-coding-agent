import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEventBus, type EventBus } from "@octocodeai/octocode-agent-core";
import { registerFeature } from "../../src/core/features/register.ts";
import { createExtensionRuntime } from "../../src/core/features/runtime.ts";
import type {
	Extension,
	ExtensionFactory,
	ExtensionRuntime,
	LoadExtensionsResult,
} from "../../src/core/features/types.ts";
import type { FeatureOwner } from "../../src/core/source-info.ts";

export { createExtensionRuntime };

/** Register one factory as a feature, as the resource loader does, and return its registrations. */
export function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	path = "<inline>",
	owner: FeatureOwner = "builtin",
): Promise<Extension> {
	return registerFeature({ id: path, owner, path, register: factory }, eventBus, runtime, cwd);
}

/**
 * Register feature modules from files, for tests that exercise the runner with fixture modules. The product never
 * loads files; this helper imports each module's default export and registers it as a feature.
 */
export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus: EventBus = createEventBus(),
	runtime: ExtensionRuntime = createExtensionRuntime(),
): Promise<LoadExtensionsResult> {
	const result: LoadExtensionsResult = { extensions: [], errors: [], warnings: [], runtime };
	for (const file of paths) {
		try {
			const factory = (await import(pathToFileURL(file).href)).default as ExtensionFactory;
			if (typeof factory !== "function") {
				result.errors.push({ path: file, error: `Extension does not export a valid factory function: ${file}` });
				continue;
			}
			result.extensions.push(await loadExtensionFromFactory(factory, cwd, eventBus, runtime, file));
		} catch (error) {
			result.errors.push({
				path: file,
				error: `Failed to load extension: ${error instanceof Error ? error.message : error}`,
			});
		}
	}
	return result;
}

/** `loadExtensions` for the `*.ts` files directly in `<agentDir>/extensions/`. */
export function discoverAndLoadExtensions(
	_configured: string[],
	cwd: string,
	agentDir: string,
): Promise<LoadExtensionsResult> {
	const dir = join(agentDir, "extensions");
	const files = existsSync(dir)
		? readdirSync(dir)
				.filter((name) => name.endsWith(".ts"))
				.sort()
				.map((name) => join(dir, name))
		: [];
	return loadExtensions(files, cwd);
}
