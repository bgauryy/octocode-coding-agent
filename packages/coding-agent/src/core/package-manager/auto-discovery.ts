import { configDiscovery, discoveryInput } from "../discovery/service.ts";
import type { ConfigKind } from "../discovery/types.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { isEnabledByOverrides } from "./patterns.ts";
import { addResource, getTargetMap } from "./resources.ts";
import {
	getHomeDir,
	type PackageManagerHost,
	type PathMetadata,
	type ResourceAccumulator,
	type ResourceType,
} from "./types.ts";

const AUTO_KINDS: ReadonlyArray<readonly [ConfigKind, ResourceType]> = [
	["extension", "extensions"],
	["skill", "skills"],
	["prompt", "prompts"],
	["theme", "themes"],
];

/**
 * Add what the standard folders hold (Octocode's global directory, the shared `.agents` folders, and for a trusted folder
 * `.octocode/` and, with Pi compatibility, `.pi/`) to `accumulator`, in discovery's precedence order. Pi's global roots are
 * not read here: the Pi fallback resolves them with Pi's own settings (`FeatureSetLoader.resolveResources`).
 */
export function addAutoDiscoveredResources(
	host: PackageManagerHost,
	accumulator: ResourceAccumulator,
	globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
	projectSettings: ReturnType<SettingsManager["getProjectSettings"]>,
	globalBaseDir: string,
	projectBaseDir: string,
): void {
	const overrides = (settings: typeof globalSettings, type: ResourceType): string[] => settings[type] ?? [];
	const input = discoveryInput({
		cwd: host.cwd,
		agentDir: host.agentDir,
		home: getHomeDir(),
		projectTrusted: host.settingsManager.isProjectTrusted(),
	});
	for (const [kind, type] of AUTO_KINDS) {
		const target = getTargetMap(accumulator, type);
		for (const { provenance } of configDiscovery.discover(kind, input)) {
			if (provenance.scope === "builtin" || (provenance.product === "pi" && provenance.scope === "global")) continue;
			const project = provenance.scope === "project";
			const baseDir = provenance.baseDir ?? (project ? projectBaseDir : globalBaseDir);
			const metadata: PathMetadata = {
				source: "auto",
				scope: project ? "project" : "user",
				origin: "top-level",
				baseDir,
			};
			const patterns = overrides(project ? projectSettings : globalSettings, type);
			addResource(target, provenance.path, metadata, isEnabledByOverrides(provenance.path, patterns, baseDir));
		}
	}
}
