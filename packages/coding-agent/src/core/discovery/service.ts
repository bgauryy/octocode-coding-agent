import { homedir } from "node:os";
import { getPiConfigDirs } from "../../config.ts";
import { applyPrecedence } from "./precedence.ts";
import type { ConfigItem, ConfigKind, DiscoverInput, DiscoverySource } from "./types.ts";
import { VENDOR_SOURCES } from "./vendors/registry.ts";

/** The fields that decide what discovery returns; `env` counts only when a caller passes its own. */
function inputKey(kind: ConfigKind, input: DiscoverInput): string {
	const { env, ...rest } = input;
	return JSON.stringify([kind, rest, env === undefined || env === process.env ? null : env]);
}

/**
 * Every configuration item of a kind with where it came from and which copy wins. Each harness (`vendors/`) supplies its
 * sources; the host registers the kinds it owns (agents, MCP servers) through {@link ConfigDiscovery.register}, the way it
 * installs the folder-trust resolver.
 *
 * Each call walks the folders again, except inside {@link ConfigDiscovery.pass}: one reload asks for the same kinds many
 * times (package resolve per Pi folder, context, prompts), so a pass reads each (kind, input) once.
 */
class ConfigDiscovery {
	private readonly hosted: DiscoverySource[] = [];
	private memo?: Map<string, ConfigItem[]>;
	private depth = 0;
	/** Counts passes, so a cache built on discovery (`harnessStatuses`) knows a reload happened. */
	generation = 0;

	/** Add a source for a kind the host owns. Returns the function that removes it. */
	register(source: DiscoverySource): () => void {
		this.hosted.push(source);
		this.memo?.clear();
		return () => {
			const index = this.hosted.indexOf(source);
			if (index >= 0) this.hosted.splice(index, 1);
			this.memo?.clear();
		};
	}

	/** Run `work` with discovery read once per (kind, input); a new pass starts from the folders again. */
	async pass<T>(work: () => Promise<T>): Promise<T> {
		if (this.depth++ === 0) {
			this.memo = new Map();
			this.generation++;
		}
		try {
			return await work();
		} finally {
			if (--this.depth === 0) this.memo = undefined;
		}
	}

	/**
	 * The items of `kind` in precedence order. `loaded` is false for a shadowed item (`provenance.shadowedBy` names the
	 * winner) and for one that is not loaded (`provenance.notLoaded`). A loader that keeps its own collision diagnostics
	 * reads every item without `notLoaded`.
	 */
	discover(kind: ConfigKind, input: DiscoverInput): ConfigItem[] {
		const key = this.memo ? inputKey(kind, input) : undefined;
		const cached = key === undefined ? undefined : this.memo?.get(key);
		if (cached) return [...cached];
		const sources = [...VENDOR_SOURCES, ...this.hosted].filter((source) => source.kind === kind);
		const items = applyPrecedence(
			kind,
			sources.flatMap((source) => source.discover(input)),
		);
		if (key !== undefined) this.memo?.set(key, items);
		return [...items];
	}

	discoverAll(input: DiscoverInput): Map<ConfigKind, ConfigItem[]> {
		const kinds = new Set<ConfigKind>([...VENDOR_SOURCES, ...this.hosted].map((source) => source.kind));
		return new Map([...kinds].map((kind) => [kind, this.discover(kind, input)]));
	}
}

export const configDiscovery = new ConfigDiscovery();

/** The input for a session: Pi roots come from the same rule as the rest of the Pi fallback (`getPiConfigDirs`). */
export function discoveryInput(
	options: Pick<DiscoverInput, "cwd" | "agentDir" | "projectTrusted"> & Partial<DiscoverInput>,
): DiscoverInput {
	return { home: homedir(), piRoots: getPiConfigDirs(options.agentDir), ...options };
}
