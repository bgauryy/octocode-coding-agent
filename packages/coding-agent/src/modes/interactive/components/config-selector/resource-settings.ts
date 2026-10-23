import { dirname, join, relative } from "node:path";
import { CONFIG_DIR_NAME } from "../../../../config.ts";
import type { PackageSource, SettingsManager } from "../../../../core/settings-manager.ts";
import {
	isOverridePattern,
	overridePatternTarget,
	withTogglePattern,
} from "../../../../core/package-manager/patterns.ts";
import { canonicalizePath, isLocalPath, resolvePath } from "../../../../utils/paths.ts";
import {
	type ProjectOverrideState,
	RESOURCE_TYPES,
	type ResourceGroup,
	type ResourceItem,
	type ResourceType,
	type SettingsScope,
} from "./groups.ts";

/**
 * Reads and writes resource enablement patterns in global and project settings.
 */
export class ResourceSettings {
	private settingsManager: SettingsManager;
	private cwd: string;
	private agentDir: string;
	private inheritedEnabledByKey: Map<string, boolean>;

	constructor(settingsManager: SettingsManager, cwd: string, agentDir: string, globalGroups: ResourceGroup[]) {
		this.settingsManager = settingsManager;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.inheritedEnabledByKey = this.buildInheritedEnabledMap(globalGroups);
	}

	private buildInheritedEnabledMap(groups: ResourceGroup[]): Map<string, boolean> {
		const result = new Map<string, boolean>();
		for (const group of groups) {
			for (const subgroup of group.subgroups) {
				for (const item of subgroup.items) {
					result.set(this.getResourceItemKey(item), item.enabled);
				}
			}
		}
		return result;
	}

	toggleTopLevelResource(item: ResourceItem, enabled: boolean): void {
		const scope = item.metadata.scope as "user" | "project";
		const settings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();

		const arrayKey = item.resourceType;
		const current = settings[arrayKey] ?? [];

		const updated = withTogglePattern(current, this.getResourcePattern(item), enabled);

		if (scope === "project") {
			if (arrayKey === "extensions") {
				this.settingsManager.setProjectExtensionPaths(updated);
			} else if (arrayKey === "skills") {
				this.settingsManager.setProjectSkillPaths(updated);
			} else if (arrayKey === "prompts") {
				this.settingsManager.setProjectPromptTemplatePaths(updated);
			} else if (arrayKey === "themes") {
				this.settingsManager.setProjectThemePaths(updated);
			}
		} else {
			if (arrayKey === "extensions") {
				this.settingsManager.setExtensionPaths(updated);
			} else if (arrayKey === "skills") {
				this.settingsManager.setSkillPaths(updated);
			} else if (arrayKey === "prompts") {
				this.settingsManager.setPromptTemplatePaths(updated);
			} else if (arrayKey === "themes") {
				this.settingsManager.setThemePaths(updated);
			}
		}
	}

	togglePackageResource(item: ResourceItem, enabled: boolean): void {
		const scope = item.metadata.scope as "user" | "project";
		const settings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();

		const packages = [...(settings.packages ?? [])] as PackageSource[];
		const pkgIndex = packages.findIndex((pkg) => {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			return source === item.metadata.source;
		});

		if (pkgIndex === -1) return;

		let pkg = packages[pkgIndex];

		// Convert string to object form if needed
		if (typeof pkg === "string") {
			pkg = { source: pkg };
			packages[pkgIndex] = pkg;
		}

		// Get the resource array for this type
		const arrayKey = item.resourceType;
		const current = pkg[arrayKey] ?? [];

		// Pattern relative to the package root
		const updated = withTogglePattern(current, this.getPackageResourcePattern(item), enabled);

		(pkg as Record<string, unknown>)[arrayKey] = updated.length > 0 ? updated : undefined;

		// Clean up empty filter object
		const hasFilters = ["extensions", "skills", "prompts", "themes"].some(
			(k) => (pkg as Record<string, unknown>)[k] !== undefined,
		);
		if (!hasFilters) {
			packages[pkgIndex] = (pkg as { source: string }).source;
		}

		if (scope === "project") {
			this.settingsManager.setProjectPackages(packages);
		} else {
			this.settingsManager.setPackages(packages);
		}
	}

	setProjectResourceOverride(item: ResourceItem, state: ProjectOverrideState): boolean {
		return item.metadata.origin === "top-level"
			? this.setProjectTopLevelOverride(item, state)
			: this.setProjectPackageOverride(item, state);
	}

	private setProjectTopLevelOverride(item: ResourceItem, state: ProjectOverrideState): boolean {
		const current = this.settingsManager.getProjectSettings()[item.resourceType] ?? [];
		const pattern = this.isInheritedGlobalItem(item) ? item.path : this.getResourcePatternForScope(item, "project");
		const patterns = this.getTopLevelOverridePatterns(item, "project");
		const updated = current.filter((entry) => {
			const target = overridePatternTarget(entry);
			if (isOverridePattern(entry) && patterns.has(target)) return false;
			return !(state === "inherit" && this.isInheritedGlobalItem(item) && target === pattern);
		});
		if (state !== "inherit") {
			// Project entries name inherited files to override them. Built-in paths need no entry.
			if (this.isInheritedGlobalItem(item) && item.metadata.source !== "builtin" && !updated.includes(pattern))
				updated.push(pattern);
			updated.push(`${state === "load" ? "+" : "-"}${pattern}`);
		}
		this.setProjectTopLevelPaths(item.resourceType, updated);
		return true;
	}

	private setProjectTopLevelPaths(key: ResourceType, paths: string[]): void {
		if (key === "extensions") this.settingsManager.setProjectExtensionPaths(paths);
		else if (key === "skills") this.settingsManager.setProjectSkillPaths(paths);
		else if (key === "prompts") this.settingsManager.setProjectPromptTemplatePaths(paths);
		else this.settingsManager.setProjectThemePaths(paths);
	}

	private setProjectPackageOverride(item: ResourceItem, state: ProjectOverrideState): boolean {
		const packages = [...(this.settingsManager.getProjectSettings().packages ?? [])] as PackageSource[];
		let pkgIndex = packages.findIndex((pkg) =>
			this.packageSourceStringMatches(
				item.metadata.source,
				this.getItemScope(item),
				typeof pkg === "string" ? pkg : pkg.source,
				"project",
			),
		);
		if (pkgIndex === -1) {
			if (state === "inherit") return false;
			packages.push(this.createPackageOverrideSource(item));
			pkgIndex = packages.length - 1;
		}
		let pkg = packages[pkgIndex];
		if (pkg === undefined) return false;
		if (typeof pkg === "string") {
			pkg = { source: pkg };
			packages[pkgIndex] = pkg;
		}
		const pattern = this.getPackageResourcePattern(item);
		const updated = (pkg[item.resourceType] ?? []).filter((entry) => overridePatternTarget(entry) !== pattern);
		if (state !== "inherit") updated.push(`${state === "load" ? "+" : "-"}${pattern}`);
		(pkg as Record<string, unknown>)[item.resourceType] = updated.length > 0 ? updated : undefined;
		if (!RESOURCE_TYPES.some((key) => (pkg as Record<string, unknown>)[key] !== undefined)) {
			if (pkg.autoload === false) packages.splice(pkgIndex, 1);
			else packages[pkgIndex] = pkg.source;
		}
		this.settingsManager.setProjectPackages(packages);
		return true;
	}

	getNextOverrideState(item: ResourceItem): ProjectOverrideState {
		const state = this.getProjectOverrideState(item);
		const inheritedEnabled = this.getInheritedEnabled(item);
		if (state === "inherit") return inheritedEnabled ? "unload" : "load";
		if (state === "unload") return inheritedEnabled ? "load" : "inherit";
		return inheritedEnabled ? "inherit" : "unload";
	}

	/** Project override state of an item; callers check that the project write scope is active. */
	getProjectOverrideState(item: ResourceItem): ProjectOverrideState {
		if (item.metadata.origin === "top-level") {
			return this.getOverrideStateFromEntries(
				this.settingsManager.getProjectSettings()[item.resourceType] ?? [],
				this.getTopLevelOverridePatterns(item, "project"),
				false,
			);
		}
		const pkg = this.findMatchingPackageSource(item, "project");
		if (typeof pkg !== "object") return "inherit";
		const entries = pkg[item.resourceType];
		if (entries === undefined) return "inherit";
		return this.getOverrideStateFromEntries(
			entries,
			new Set([this.getPackageResourcePattern(item)]),
			pkg.autoload !== false,
		);
	}

	private getOverrideStateFromEntries(
		entries: string[],
		patterns: Set<string>,
		emptyArrayIsUnload: boolean,
	): ProjectOverrideState {
		if (entries.length === 0 && emptyArrayIsUnload) return "unload";
		let state: ProjectOverrideState = "inherit";
		for (const entry of entries) {
			if (!patterns.has(overridePatternTarget(entry))) continue;
			if (entry.startsWith("!") || entry.startsWith("-")) state = "unload";
			else state = "load";
		}
		return state;
	}

	getInheritedEnabled(item: ResourceItem): boolean {
		return (
			this.inheritedEnabledByKey.get(this.getResourceItemKey(item)) ??
			(this.getItemScope(item) === "user" ? item.enabled : true)
		);
	}

	isInheritedGlobalItem(item: ResourceItem): boolean {
		return this.getItemScope(item) === "user" || this.inheritedEnabledByKey.has(this.getResourceItemKey(item));
	}

	private getTopLevelOverridePatterns(item: ResourceItem, scope: SettingsScope): Set<string> {
		const baseDir = this.getTopLevelBaseDir(scope);
		const patterns = new Set<string>([
			this.getResourcePatternForScope(item, scope),
			item.path,
			relative(baseDir, item.path),
		]);
		if (item.metadata.baseDir) patterns.add(relative(item.metadata.baseDir, item.path));
		return patterns;
	}

	private getResourcePatternForScope(item: ResourceItem, scope: SettingsScope): string {
		const sourceScope = this.getItemScope(item);
		if (scope !== sourceScope || item.metadata.source === "builtin") return item.path;
		const baseDir = item.metadata.baseDir ?? this.getTopLevelBaseDir(sourceScope);
		return relative(baseDir, item.path);
	}

	private createPackageOverrideSource(item: ResourceItem): PackageSource {
		const source = item.metadata.source;
		if (!isLocalPath(source)) return { source, autoload: false };
		const sourcePath = resolvePath(source, this.getTopLevelBaseDir(this.getItemScope(item)), { trim: true });
		return { source: relative(this.getTopLevelBaseDir("project"), sourcePath) || ".", autoload: false };
	}

	private packageSourceStringMatches(
		leftSource: string,
		leftScope: SettingsScope,
		rightSource: string,
		rightScope: SettingsScope,
	): boolean {
		if (leftSource === rightSource) return true;
		if (!isLocalPath(leftSource) || !isLocalPath(rightSource)) return false;
		const left = resolvePath(leftSource, this.getTopLevelBaseDir(leftScope), { trim: true });
		const right = resolvePath(rightSource, this.getTopLevelBaseDir(rightScope), { trim: true });
		return left === right;
	}

	private findMatchingPackageSource(item: ResourceItem, targetScope: SettingsScope): PackageSource | undefined {
		const settings =
			targetScope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		return (settings.packages ?? []).find((pkg) =>
			this.packageSourceStringMatches(
				item.metadata.source,
				this.getItemScope(item),
				typeof pkg === "string" ? pkg : pkg.source,
				targetScope,
			),
		);
	}

	private getResourceItemKey(item: ResourceItem): string {
		return `${item.resourceType}:${canonicalizePath(item.path)}`;
	}

	getItemScope(item: ResourceItem): SettingsScope {
		return item.metadata.scope === "project" ? "project" : "user";
	}

	private getTopLevelBaseDir(scope: "user" | "project"): string {
		return scope === "project" ? join(this.cwd, CONFIG_DIR_NAME) : this.agentDir;
	}

	private getResourcePattern(item: ResourceItem): string {
		if (item.metadata.source === "builtin") return item.path;
		const scope = item.metadata.scope as "user" | "project";
		const baseDir = item.metadata.baseDir ?? this.getTopLevelBaseDir(scope);
		return relative(baseDir, item.path);
	}

	private getPackageResourcePattern(item: ResourceItem): string {
		const baseDir = item.metadata.baseDir ?? dirname(item.path);
		return relative(baseDir, item.path);
	}
}
