import type { EventBus } from "@octocodeai/octocode-agent-core";
import { createSyntheticSourceInfo, getSyntheticPathSource } from "../source-info.ts";
import { time } from "../timings.ts";
import { createExtensionAPI } from "./api.ts";
import type { Extension, ExtensionRuntime, Feature } from "./types.ts";

/** The source path that names a feature in diagnostics and tool or command sources. */
function featurePath(feature: Feature): string {
	return feature.owner === "native" ? `<inline:${feature.id}>` : `builtin:${feature.id}`;
}

/**
 * Register a feature: run its `register` function against a fresh API and return the feature's registrations. A
 * failed registration is discarded whole and rethrown, so a partly registered feature never reaches the session.
 */
export async function registerFeature(
	feature: Feature,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	cwd: string,
): Promise<Extension> {
	const path = feature.path ?? featurePath(feature);
	const extension: Extension = {
		path,
		id: feature.id,
		owner: feature.owner,
		hidden: feature.hidden,
		sourceInfo: createSyntheticSourceInfo(path, {
			source: getSyntheticPathSource(path) ?? "builtin",
			owner: feature.owner,
		}),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		shortcuts: new Map(),
	};
	const load = createExtensionAPI(extension, runtime, cwd, eventBus);
	try {
		await feature.register(load.api);
		load.commit();
	} catch (error) {
		load.discard();
		throw error;
	}
	time(`${path} register`, "extensions");
	return extension;
}
