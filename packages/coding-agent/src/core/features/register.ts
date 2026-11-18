import type { EventBus } from "@octocodeai/octocode-agent-core";
import { createSyntheticSourceInfo, getSyntheticPathSource } from "../source-info.ts";
import { time } from "../timings.ts";
import { createFeatureSetup } from "./api.ts";
import type { FeatureRecord, FeatureRuntime, Feature } from "./types.ts";

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
	runtime: FeatureRuntime,
): Promise<FeatureRecord> {
	const path = feature.path ?? featurePath(feature);
	const record: FeatureRecord = {
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
	};
	const load = createFeatureSetup(record, runtime, eventBus);
	try {
		await feature.register(load.setup);
		load.commit();
	} catch (error) {
		load.discard();
		throw error;
	}
	time(`${path} register`, "features");
	return record;
}
