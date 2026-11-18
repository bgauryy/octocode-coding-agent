import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { EventBus } from "@octocodeai/octocode-agent-core";
import { readJsonFile } from "@octocodeai/octocode-common/json";
import { canonicalizePath } from "@octocodeai/octocode-common/paths";
import { CONFIG_DIR_NAME, getLegacyConfigDirs } from "../../config.ts";
import { configDiscovery, discoveryInput } from "../discovery/service.ts";
import { vendorOn } from "../discovery/vendors/switch.ts";
import type { DiscoverInput } from "../discovery/types.ts";
import { detectFeatureConflicts } from "../features/conflicts.ts";
import { createFeatureRuntime } from "../features/runtime.ts";
import { registerFeature } from "../features/register.ts";
import type { Feature, LoadedFeatures, LoadWarning } from "../features/types.ts";
import { effectivePlugins } from "../extensibility/toggles.ts";
import { DefaultPackageManager, type ResolvedPaths, type ResolvedResource } from "../package-manager.ts";
import { loadConfiguredPluginMcp } from "../plugin-mcp.ts";
import { SettingsManager } from "../settings-manager.ts";

/** Pi's TypeScript hooks, which Octocode lists but never loads. */
const PI_HOOK_NOT_LOADED =
	"Pi hook, not loaded. Octocode does not run Pi TypeScript hooks; convert it to a hooks.json entry or a plugin (see docs/plugins.md).";

/** The resource loader configuration that feature registration reads; fixed after construction. */
export interface FeatureLoadingConfig {
	readonly cwd: string;
	readonly agentDir: string;
	readonly settingsManager: SettingsManager;
	readonly eventBus: EventBus;
	readonly packageManager: DefaultPackageManager;
	/** The built-in features available to this session, before `disabledFeatures` switches any off. */
	readonly builtinFeatures: readonly Feature[];
	/** The native feature set, absent for a session that supplies its own tool policy. */
	readonly nativeFeature: Feature | undefined;
	/** Features injected next to the defaults (tests and hosts that wrap the core). */
	readonly injected: readonly Feature[];
	readonly disabledFeatures: ReadonlySet<string>;
}

/**
 * Warnings for the Pi hook files Octocode lists but never runs. A file that discovery lists as not loaded carries
 * `listedInContext`: the context view says so, once.
 */
export function ignoredCodeWarnings(input: DiscoverInput): LoadWarning[] {
	return configDiscovery
		.discover("hook", input)
		.filter((item) => item.provenance.notLoaded === "ignored-code")
		.map((item) => ({ path: item.provenance.path, warning: PI_HOOK_NOT_LOADED, listedInContext: true }));
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
	 * (`harness:pi`) its skills, prompts and themes are left out; a Pi skill another harness supplies is left out too.
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
			for (const kind of ["skills", "prompts", "themes"] as const) {
				if (!piOn) continue;
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

	/**
	 * Register the session's features, in order: the built-ins, the native feature set, injected features, then the MCP
	 * servers of configured plugins. A feature whose registration throws is reported and skipped, except the native
	 * set, whose failure fails startup.
	 */
	async loadFeatures(): Promise<LoadedFeatures> {
		const { cwd, eventBus, disabledFeatures } = this.config;
		const runtime = createFeatureRuntime();
		const result: LoadedFeatures = { features: [], errors: [], warnings: [], runtime };
		const register = async (feature: Feature) => {
			try {
				result.features.push(await registerFeature(feature, eventBus, runtime));
			} catch (error) {
				// Without the native set a session would run with no permission checks or native tools: stop startup instead.
				if (feature.owner === "native") throw error;
				result.errors.push({
					path: feature.path ?? `${feature.owner}:${feature.id}`,
					error: error instanceof Error ? error.message : "failed to register feature",
				});
			}
		};
		for (const feature of this.config.builtinFeatures) {
			if (!disabledFeatures.has(feature.id)) await register(feature);
		}
		if (this.config.nativeFeature) await register(this.config.nativeFeature);
		for (const feature of this.config.injected) await register(feature);
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
					for (const server of pluginMcp.servers) api.mcpServers.register(server.name, server.config);
				},
			});
		}
		for (const conflict of detectFeatureConflicts(result.features)) {
			result.errors.push({ path: conflict.path, error: conflict.message });
		}
		return result;
	}
}
