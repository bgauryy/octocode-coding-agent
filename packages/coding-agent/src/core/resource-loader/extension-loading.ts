import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getLegacyConfigDirs } from "../../config.ts";
import octocode from "../../octocode/index.ts";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import { stripBom } from "../../utils/text.ts";
import type { EventBus } from "../event-bus.ts";
import { loadExtensionFromFactory, loadExtensionsCached } from "../extensions/loader.ts";
import type { Extension, ExtensionRuntime, InlineExtension, LoadExtensionsResult } from "../extensions/types.ts";
import { DefaultPackageManager, type ResolvedPaths, type ResolvedResource } from "../package-manager.ts";
import { loadConfiguredPluginMcp } from "../plugin-mcp.ts";
import { SettingsManager } from "../settings-manager.ts";
import { BUILTIN_PATH_PREFIX, isSyntheticPath } from "../source-info.ts";
import {
	type BuiltinExtension,
	collectExtensionPackageWarnings,
	detectExtensionConflicts,
	mergeExtensionWarnings,
	omitReplacedExtensions,
} from "./extension-sets.ts";
import { mergePaths } from "./paths.ts";

/** The resource loader configuration that extension loading reads; fixed after construction. */
export interface ExtensionLoadingConfig {
	readonly cwd: string;
	readonly agentDir: string;
	readonly settingsManager: SettingsManager;
	readonly eventBus: EventBus;
	readonly packageManager: DefaultPackageManager;
	readonly additionalExtensionPaths: string[];
	readonly extensionFactories: InlineExtension[];
	readonly nativeFeatures: boolean;
	readonly builtinExtensions: Map<string, BuiltinExtension>;
	readonly noExtensions: boolean;
	readonly disabledBuiltinExtensions: Set<string>;
}

/**
 * Extension loading for `DefaultResourceLoader`: the pre-trust extension set, resource resolution with the Pi
 * fallback, and the final extension set with built-in, inline and plugin MCP extensions.
 */
export class ExtensionSetLoader {
	private readonly config: ExtensionLoadingConfig;

	constructor(config: ExtensionLoadingConfig) {
		this.config = config;
	}

	async loadCurrentExtensionSet(options: { includeInlineFactories: boolean }): Promise<LoadExtensionsResult> {
		const resolvedPaths = await this.resolveResources();
		const cliExtensionPaths = await this.config.packageManager.resolveExtensionSources(
			this.config.additionalExtensionPaths,
			{
				temporary: true,
			},
		);
		const enabledExtensions = resolvedPaths.extensions.filter((r) => r.enabled).map((r) => r.path);
		const cliEnabledExtensions = cliExtensionPaths.extensions.filter((r) => r.enabled).map((r) => r.path);
		// Built-in extensions wait for the final pass: project settings can disable them, and a loaded
		// extension cannot be unloaded.
		const extensionPaths = (
			this.config.noExtensions
				? cliEnabledExtensions
				: mergePaths(this.config.cwd, cliEnabledExtensions, enabledExtensions)
		).filter((path) => !path.startsWith(BUILTIN_PATH_PREFIX));
		const metadataByPath = new Map(
			[...resolvedPaths.extensions, ...cliExtensionPaths.extensions].map((resource) => [
				resource.path,
				resource.metadata,
			]),
		);
		const packageWarnings = collectExtensionPackageWarnings(extensionPaths, metadataByPath);
		const extensionsResult = await loadExtensionsCached(extensionPaths, this.config.cwd, this.config.eventBus);
		mergeExtensionWarnings(extensionsResult, packageWarnings);
		if (!options.includeInlineFactories) {
			return extensionsResult;
		}

		const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
		extensionsResult.extensions.push(...inlineExtensions.extensions);
		extensionsResult.errors.push(...inlineExtensions.errors);
		const replacementWarnings: Array<{ path: string; warning: string }> = [];
		extensionsResult.extensions = omitReplacedExtensions(extensionsResult.extensions, replacementWarnings);
		mergeExtensionWarnings(extensionsResult, replacementWarnings);
		return extensionsResult;
	}

	async resolveResources(): Promise<ResolvedPaths> {
		const resolved = await this.config.packageManager.resolve();
		const legacyDirs = getLegacyConfigDirs(this.config.agentDir);
		const roots = [join(this.config.cwd, CONFIG_DIR_NAME), this.config.agentDir, ...legacyDirs];
		const packageNames = new Map<string, string | undefined>();
		const packageName = (item: ResolvedResource): string | undefined => {
			const root = item.metadata.packageRoot;
			if (!root) return undefined;
			if (!packageNames.has(root)) {
				const manifest = JSON.parse(stripBom(readFileSync(join(root, "package.json"), "utf-8"))) as {
					name?: string;
				};
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
					const name = packageName(item);
					if (name !== undefined && nativePackages.has(name)) continue;
					if (kind === "extensions" && this.config.nativeFeatures && name === "@octocodeai/pi-extension") continue;
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

	private resolveExtensionLoadPath(path: string): string {
		return isSyntheticPath(path) ? path : resolvePath(path, this.config.cwd, { normalizeUnicodeSpaces: true });
	}

	/** Load extension paths: files from disk and `builtin:<name>` paths from the built-in extensions. */
	private async loadExtensionPaths(paths: string[], runtime?: ExtensionRuntime): Promise<LoadExtensionsResult> {
		const isBuiltinPath = (path: string) => path.startsWith(BUILTIN_PATH_PREFIX);
		const result = await loadExtensionsCached(
			paths.filter((path) => !isBuiltinPath(path)),
			this.config.cwd,
			this.config.eventBus,
			runtime,
		);
		for (const path of paths.filter(isBuiltinPath)) {
			const builtin = this.config.builtinExtensions.get(path.slice(BUILTIN_PATH_PREFIX.length));
			if (!builtin) {
				result.errors.push({
					path,
					error: `Unknown built-in extension: ${path}`,
				});
				continue;
			}
			try {
				const extension = await loadExtensionFromFactory(
					builtin.factory,
					this.config.cwd,
					this.config.eventBus,
					result.runtime,
					path,
				);
				extension.hidden = true;
				extension.replaceable = builtin.replaceable === true;
				result.extensions.push(extension);
			} catch (error) {
				result.errors.push({
					path,
					error: error instanceof Error ? error.message : "failed to load extension",
				});
			}
		}
		return result;
	}

	async loadFinalExtensionSet(
		extensionPaths: string[],
		preTrustExtensions: LoadExtensionsResult | undefined,
	): Promise<LoadExtensionsResult> {
		// Without a pre-trust pass nothing is preloaded, and inline extensions load here.
		const preloaded = preTrustExtensions?.extensions ?? [];
		const preloadedByPath = new Map(
			preloaded
				.filter((extension) => !extension.path.startsWith("<inline:"))
				.map((extension) => [extension.resolvedPath, extension]),
		);
		const failedPreloadPaths = new Set(
			(preTrustExtensions?.errors ?? []).map((error) => this.resolveExtensionLoadPath(error.path)),
		);
		const remainingPaths = extensionPaths.filter((path) => {
			const resolvedPath = this.resolveExtensionLoadPath(path);
			return !preloadedByPath.has(resolvedPath) && !failedPreloadPaths.has(resolvedPath);
		});
		const remainingExtensions = await this.loadExtensionPaths(remainingPaths, preTrustExtensions?.runtime);
		const loadedByPath = new Map(preloadedByPath);
		for (const extension of remainingExtensions.extensions) {
			loadedByPath.set(extension.resolvedPath, extension);
		}

		const inlineExtensions = preTrustExtensions
			? {
					extensions: preloaded.filter((extension) => extension.path.startsWith("<inline:")),
					errors: [],
				}
			: await this.loadExtensionFactories(remainingExtensions.runtime);
		const orderedExtensions = extensionPaths
			.map((path) => loadedByPath.get(this.resolveExtensionLoadPath(path)))
			.filter((extension): extension is Extension => extension !== undefined);
		orderedExtensions.push(...inlineExtensions.extensions);
		const pluginMcp = loadConfiguredPluginMcp(this.config.settingsManager.getSettings().plugins, this.config.cwd);
		for (const error of pluginMcp.errors) inlineExtensions.errors.push({ path: "settings.plugins", error });
		if (pluginMcp.servers.length) {
			try {
				const extension = await loadExtensionFromFactory(
					(pi) => {
						for (const server of pluginMcp.servers) pi.registerMcpServer(server.name, server.config);
					},
					this.config.cwd,
					this.config.eventBus,
					remainingExtensions.runtime,
					"<inline:plugin-mcp>",
				);
				extension.hidden = true;
				orderedExtensions.push(extension);
			} catch (error) {
				inlineExtensions.errors.push({
					path: "settings.plugins",
					error: String(error),
				});
			}
		}

		const replacementWarnings: Array<{ path: string; warning: string }> = [];
		const extensionsResult: LoadExtensionsResult = {
			extensions: omitReplacedExtensions(orderedExtensions, replacementWarnings),
			errors: [...(preTrustExtensions?.errors ?? []), ...remainingExtensions.errors, ...inlineExtensions.errors],
			warnings: [...(preTrustExtensions?.warnings ?? []), ...(remainingExtensions.warnings ?? [])],
			runtime: remainingExtensions.runtime,
		};
		mergeExtensionWarnings(extensionsResult, replacementWarnings);
		this.addExtensionConflictDiagnostics(extensionsResult);
		return extensionsResult;
	}

	private addExtensionConflictDiagnostics(extensionsResult: LoadExtensionsResult): void {
		// Detect extension conflicts (tools, commands, flags with same names from different extensions)
		// Keep all extensions loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.
		const conflicts = detectExtensionConflicts(extensionsResult.extensions);
		for (const conflict of conflicts) {
			extensionsResult.errors.push({
				path: conflict.path,
				error: conflict.message,
			});
		}
	}

	private async loadExtensionFactories(runtime: ExtensionRuntime): Promise<{
		extensions: Extension[];
		errors: Array<{ path: string; error: string }>;
	}> {
		const extensions: Extension[] = [];
		const errors: Array<{ path: string; error: string }> = [];

		if (this.config.nativeFeatures) {
			const native = await loadExtensionFromFactory(
				(pi) => octocode(pi, { mcp: !this.config.disabledBuiltinExtensions.has("mcp") }),
				this.config.cwd,
				this.config.eventBus,
				runtime,
				"<inline:octocode>",
			);
			native.hidden = true;
			extensions.push(native);
		}

		for (const [index, input] of this.config.extensionFactories.entries()) {
			const isNamed = typeof input !== "function";
			const factory = isNamed ? input.factory : input;
			const extensionPath = `<inline:${isNamed ? input.name : index + 1}>`;
			try {
				const extension = await loadExtensionFromFactory(
					factory,
					this.config.cwd,
					this.config.eventBus,
					runtime,
					extensionPath,
				);
				extension.hidden = isNamed && input.hidden;
				extension.replaceable = isNamed && input.replaceable === true;
				extensions.push(extension);
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to load extension";
				errors.push({ path: extensionPath, error: message });
			}
		}

		return { extensions, errors };
	}
}
