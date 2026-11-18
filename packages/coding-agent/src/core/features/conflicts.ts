import type { FeatureRecord } from "./types.ts";

const describe = (feature: FeatureRecord) => `${feature.path} (${feature.owner})`;

/**
 * The one duplicate-id check at registration: two features may not register the same tool. Each conflict names
 * both owners, and the first registration keeps the name.
 */
export function detectFeatureConflicts(features: readonly FeatureRecord[]): Array<{ path: string; message: string }> {
	const conflicts: Array<{ path: string; message: string }> = [];
	const owners = { tool: new Map<string, FeatureRecord>() };
	for (const feature of features) {
		const claim = (kind: "tool", names: Iterable<string>, label: (name: string) => string) => {
			for (const name of names) {
				const first = owners[kind].get(name);
				if (first && first !== feature) {
					conflicts.push({
						path: feature.path,
						message: `${label(name)} registered by ${describe(feature)} conflicts with ${describe(first)}`,
					});
				} else owners[kind].set(name, feature);
			}
		};
		claim("tool", feature.tools.keys(), (name) => `Tool "${name}"`);
	}
	return conflicts;
}
