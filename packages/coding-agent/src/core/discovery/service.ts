import { homedir } from "node:os";
import { getLegacyConfigDirs } from "../../config.ts";
import { applyPrecedence } from "./precedence.ts";
import { CORE_SOURCES } from "./sources.ts";
import type { ConfigItem, ConfigKind, DiscoverInput, DiscoverySource } from "./types.ts";

/**
 * Every configuration item of a kind with where it came from and which copy wins. Core registers the file-based kinds;
 * the host registers the kinds it owns (hooks, agents, plugins) through {@link ConfigDiscovery.register}, the way it
 * installs the folder-trust resolver, so core imports nothing from `octocode/`.
 *
 * Each call walks the folders again: a reload is the only invalidation, so nothing can go stale. Loaders keep parsing.
 */
class ConfigDiscovery {
	private readonly hosted: DiscoverySource[] = [];

	/** Add a source for a kind the host owns. Returns the function that removes it. */
	register(source: DiscoverySource): () => void {
		this.hosted.push(source);
		return () => {
			const index = this.hosted.indexOf(source);
			if (index >= 0) this.hosted.splice(index, 1);
		};
	}

	/**
	 * The items of `kind` in precedence order. `loaded` is false for a shadowed item (`provenance.shadowedBy` names the
	 * winner) and for one that is not loaded (`provenance.notLoaded`). A loader that keeps its own collision diagnostics
	 * reads every item without `notLoaded`.
	 */
	discover(kind: ConfigKind, input: DiscoverInput): ConfigItem[] {
		const sources = [...CORE_SOURCES, ...this.hosted].filter((source) => source.kind === kind);
		return applyPrecedence(
			kind,
			sources.flatMap((source) => source.discover(input)),
		);
	}

	discoverAll(input: DiscoverInput): Map<ConfigKind, ConfigItem[]> {
		const kinds = new Set<ConfigKind>([...CORE_SOURCES, ...this.hosted].map((source) => source.kind));
		return new Map([...kinds].map((kind) => [kind, this.discover(kind, input)]));
	}
}

export const configDiscovery = new ConfigDiscovery();

/** The input for a session: Pi roots come from the same rule as the rest of the Pi fallback (`getLegacyConfigDirs`). */
export function discoveryInput(
	options: Pick<DiscoverInput, "cwd" | "agentDir" | "projectTrusted"> & Partial<DiscoverInput>,
): DiscoverInput {
	return { home: homedir(), piRoots: getLegacyConfigDirs(options.agentDir), ...options };
}
