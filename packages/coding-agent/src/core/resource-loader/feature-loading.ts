import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { EventBus } from "@octocodeai/octocode-agent-core";
import { readJsonFile } from "@octocodeai/octocode-common/json";
import { canonicalizePath, isUnderPath } from "@octocodeai/octocode-common/paths";
import { CONFIG_DIR_NAME, getLegacyConfigDirs } from "../../config.ts";
import { configDiscovery, discoveryInput } from "../discovery/service.ts";
import { vendorOn } from "../discovery/vendors/switch.ts";
import { PI_PROJECT_DIR_NAME } from "../discovery/roots.ts";
import type { DiscoverInput } from "../discovery/types.ts";
import { detectFeatureConflicts } from "../features/conflicts.ts";
import { createExtensionRuntime } from "../features/runtime.ts";
import { registerFeature } from "../features/register.ts";
import type { Feature, InlineExtension, LoadExtensionsResult, LoadWarning } from "../features/types.ts";
import { effectivePlugins } from "../extensibility/toggles.ts";
import {
	DefaultPackageManager,
	type PathMetadata,
	type ResolvedPaths,
	type ResolvedResource,
} from "../package-manager.ts";
import { loadConfiguredPluginMcp } from "../plugin-mcp.ts";
import { SettingsManager } from "../settings-manager.ts";
import { BUILTIN_PATH_PREFIX } from "../source-info.ts";

/** Where users learn the replacement for a user code extension. */
const EXTENSIONS_REMOVED = "User code extensions are not supported; use plugins and hooks (see docs/plugins.md).";
/** The same for Pi's TypeScript extensions and hooks, which Octocode lists but never loads. */
const PI_EXTENSION_NOT_LOADED =
	"Pi extension, not loaded. Octocode does not run Pi TypeScript extensions or hooks; convert it to a hooks.json entry or a plugin (see docs/plugins.md).";

/** The resource loader configuration that feature registration reads; fixed after construction. */
export interface FeatureLoadingConfig {
	readonly cwd: string;
	readonly agentDir: string;
	readonly settingsManager: SettingsManager;
	readonly eventBus: EventBus;
	readonly packageManager: DefaultPackageManager;
	/** The built-in features available to this session, before settings and `disabledFeatures` switch any off. */
	readonly builtinFeatures: readonly Feature[];
	/** The native feature set, absent for a session that supplies its own tool policy. */
	readonly nativeFeature: Feature | undefined;
	/** Features injected next to the defaults (tests and hosts that wrap the core). */
	readonly injected: InlineExtension[];
	readonly disabledFeatures: ReadonlySet<string>;
}

/**
 * Warnings for the `extensions` entries that name code: user code extensions were removed, so each is ignored and the
 * session starts. `builtin:<id>` entries are not code; they switch a built-in feature (see `defaultFeatures`).
 */
export function ignoredExtensionWarnings(
	extensionPaths: readonly string[],
	metadataByPath: Map<string, PathMetadata>,
	piRoots: readonly string[] = [],
): LoadWarning[] {
	return extensionPaths
		.filter((path) => !path.startsWith(BUILTIN_PATH_PREFIX))
		.map((path) => {
			const root = metadataByPath.get(path)?.packageRoot;
			const owner = root ? ` shipped by package ${root}` : "";
			if (piRoots.some((piRoot) => isUnderPath(path, piRoot))) return { path, warning: PI_EXTENSION_NOT_LOADED };
			return { path, warning: `Ignored extension${owner}. ${EXTENSIONS_REMOVED}` };
		});
}

/**
 * Warnings for the user code Octocode ignores: the `extensions` entries (see {@link ignoredExtensionWarnings}) and Pi's
 * `hooks/` files, which are not extension entries. Pi's roots are its global folders and, in a trusted folder, `.pi/`.
 * A file that discovery lists as not loaded carries `listedInContext`: the context view says so, once.
 */
export function ignoredCodeWarnings(
	extensionPaths: readonly string[],
	metadataByPath: Map<string, PathMetadata>,
	input: DiscoverInput,
): LoadWarning[] {
	const piRoots = input.piRoots.length > 0 ? [...input.piRoots, join(input.cwd, PI_PROJECT_DIR_NAME)] : [];
	const ignored = (["extension", "hook"] as const)
		.flatMap((kind) => configDiscovery.discover(kind, input))
		.filter((item) => item.provenance.notLoaded === "ignored-code");
	const listed = new Set(ignored.map((item) => canonicalizePath(item.provenance.path)));
	const hooks = ignored
		.filter((item) => item.kind === "hook")
		.map((item) => ({ path: item.provenance.path, warning: PI_EXTENSION_NOT_LOADED }));
	return [...ignoredExtensionWarnings(extensionPaths, metadataByPath, piRoots), ...hooks].map((warning) =>
		listed.has(canonicalizePath(warning.path)) ? { ...warning, listedInContext: true } : warning,
	);
}

/** The loader warnings a screen shows beside the context listing, which already lists code that is not loaded. */
export function warningsBesideListing(warnings: readonly LoadWarning[] | undefined): LoadWarning[] {
	return (warnings ?? []).filter((warning) => !warning.listedInContext);
}

/** Feature registration for `DefaultResourceLoader`, and resource resolution with the Pi fallback. */
export class FeatureSetLoader {
	private readonly config: FeatureLoadingConfig;

	constructor(config: FeatureLoadingConfig) {
		this.config = config;
	}

	/** One discovery pass for the whole resolve: the main package resolve and each Pi folder's ask for the same kinds. */
	resolveResources(): Promise<ResolvedPaths> {
		return configDiscovery.pass(() => this.resolveWithPi());
	}

	/**
	 * The packages and folders in effect, then Pi's global folders resolved with Pi's own settings. With Pi switched off
	 * (`harness:pi`) only its extensions are kept (listed, never run); a Pi skill another harness supplies is left out.
	 */
	private async resolveWithPi(): Promise<ResolvedPaths> {
		const resolved = await this.config.packageManager.resolve();
		const toggles = this.config.settingsManager.getToggles();
		const piOn = vendorOn("pi", toggles, false);
		const shadowedPiSkills = new Set(
			configDiscovery
				.discover(
					"skill",
					discoveryInput({
						cwd: this.config.cwd,
						agentDir: this.config.agentDir,
						projectTrusted: this.config.settingsManager.isProjectTrusted(),
						toggles,
					}),
				)
				.filter(
					({ provenance }) =>
						provenance.vendor === "pi" && provenance.shadowedBy && provenance.shadowedBy.vendor !== "pi",
				)
				.map((item) => canonicalizePath(item.provenance.path)),
		);
		const legacyDirs = getLegacyConfigDirs(this.config.agentDir);
		const roots = [join(this.config.cwd, CONFIG_DIR_NAME), this.config.agentDir, ...legacyDirs];
		const packageNames = new Map<string, string | undefined>();
		const packageName = (item: ResolvedResource): string | undefined => {
			const root = item.metadata.packageRoot;
			if (!root) return undefined;
			if (!packageNames.has(root)) {
				const manifest = readJsonFile<{ name?: string }>(join(root, "package.json"));
				packageNames.set(root, manifest.name);
			}
			return packageNames.get(root);
		};
		for (const agentDir of legacyDirs) {
			if (!existsSync(agentDir)) continue;
			const settingsManager = SettingsManager.create(this.config.cwd, agentDir, {
				projectTrusted: false,
			});
			const errors = settingsManager.drainErrors();
			if (errors.length) throw new Error(`Failed to read Pi configuration in ${agentDir}: ${errors[0].error.message}`);
			const manager = new DefaultPackageManager({
				cwd: this.config.cwd,
				agentDir,
				settingsManager,
			});
			const legacy = await manager.resolve(async () => "skip");
			for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
				if (kind !== "extensions" && !piOn) continue;
				const localKey = (file: string): string | undefined => {
					for (const root of roots) {
						const prefix = `${resolve(root, kind)}${sep}`;
						if (file.startsWith(prefix)) return relative(prefix, file);
					}
					return undefined;
				};
				const seen = new Set(resolved[kind].map((item) => canonicalizePath(item.path)));
				const names = new Set(resolved[kind].map((item) => localKey(item.path)));
				const nativePackages = new Set(resolved[kind].map(packageName).filter((name) => name !== undefined));
				for (const item of legacy[kind]) {
					if (seen.has(canonicalizePath(item.path))) continue;
					if (kind === "skills" && shadowedPiSkills.has(canonicalizePath(item.path))) continue;
					const name = packageName(item);
					if (name !== undefined && nativePackages.has(name)) continue;
					const local = localKey(item.path);
					if (local !== undefined && names.has(local)) continue;
					resolved[kind].push(item);
					seen.add(canonicalizePath(item.path));
					names.add(local);
				}
			}
		}
		return resolved;
	}

	private injectedFeatures(): Feature[] {
		return this.config.injected.map((input, index) => {
			const named = typeof input !== "function";
			const id = named ? input.name : String(index + 1);
			return {
				id,
				owner: "builtin",
				hidden: named && input.hidden,
				path: `<inline:${id}>`,
				register: named ? input.factory : input,
			};
		});
	}

	/**
	 * Register the session's features, in order: the enabled built-ins, the native feature set, injected features, then
	 * the MCP servers of configured plugins. A feature whose registration throws is reported and skipped.
	 */
	async loadFeatures(enabledExtensionPaths: readonly string[]): Promise<LoadExtensionsResult> {
		const { cwd, eventBus, disabledFeatures } = this.config;
		const enabledBuiltins = new Set(
			enabledExtensionPaths
				.filter((path) => path.startsWith(BUILTIN_PATH_PREFIX))
				.map((path) => path.slice(BUILTIN_PATH_PREFIX.length)),
		);
		const runtime = createExtensionRuntime();
		const result: LoadExtensionsResult = { extensions: [], errors: [], warnings: [], runtime };
		const register = async (feature: Feature) => {
			try {
				result.extensions.push(await registerFeature(feature, eventBus, runtime, cwd));
			} catch (error) {
				result.errors.push({
					path: feature.path ?? `${feature.owner}:${feature.id}`,
					error: error instanceof Error ? error.message : "failed to register feature",
				});
			}
		};
		for (const feature of this.config.builtinFeatures) {
			if (enabledBuiltins.has(feature.id) && !disabledFeatures.has(feature.id)) await register(feature);
		}
		if (this.config.nativeFeature) await register(this.config.nativeFeature);
		for (const feature of this.injectedFeatures()) await register(feature);
		const pluginMcp = loadConfiguredPluginMcp(effectivePlugins(this.config.settingsManager.getSettings(), cwd), cwd);
		for (const error of pluginMcp.errors) result.errors.push({ path: "settings.plugins", error });
		// With MCP switched off (`--no-mcp`) nothing connects servers, so plugin servers are skipped quietly.
		if (pluginMcp.servers.length && !disabledFeatures.has("mcp")) {
			await register({
				id: "plugin-mcp",
				owner: "builtin",
				hidden: true,
				path: "<inline:plugin-mcp>",
				register: (api) => {
					for (const server of pluginMcp.servers) api.registerMcpServer(server.name, server.config);
				},
			});
		}
		for (const conflict of detectFeatureConflicts(result.extensions)) {
			result.errors.push({ path: conflict.path, error: conflict.message });
		}
		return result;
	}
}
