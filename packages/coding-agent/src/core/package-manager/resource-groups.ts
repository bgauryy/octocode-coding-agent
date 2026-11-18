import { basename, dirname } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { PathMetadata, ResolvedPaths, ResolvedResource } from "../package-manager.ts";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";

export type ResourceType = "skills" | "prompts" | "themes";
export type SettingsScope = "user" | "project";
export type ProjectOverrideState = "inherit" | "load" | "unload";

export const RESOURCE_TYPES = ["skills", "prompts", "themes"] as const satisfies readonly ResourceType[];

const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
	skills: "Skills",
	prompts: "Prompts",
	themes: "Themes",
};

export interface ResourceItem {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
	resourceType: ResourceType;
	displayName: string;
	groupKey: string;
	subgroupKey: string;
}

interface ResourceSubgroup {
	type: ResourceType;
	label: string;
	items: ResourceItem[];
}

export interface ResourceGroup {
	key: string;
	label: string;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	source: string;
	subgroups: ResourceSubgroup[];
}

function formatBaseDir(baseDir: string): string {
	// Home written `~`, separators shown as `/` on every system.
	const displayPath = homeTilde(baseDir).replace(/\\/g, "/");
	return displayPath.endsWith("/") ? displayPath : `${displayPath}/`;
}

function getGroupLabel(metadata: PathMetadata, agentDir: string): string {
	if (metadata.origin === "package") {
		return `${metadata.source} (${metadata.scope})`;
	}
	if (metadata.source === "builtin") {
		return metadata.scope === "user" ? "Built-in" : "Built-in (project override)";
	}
	// Top-level resources
	if (metadata.source === "auto") {
		if (metadata.baseDir) {
			return metadata.scope === "user"
				? `User (${formatBaseDir(metadata.baseDir)})`
				: `Project (${formatBaseDir(metadata.baseDir)})`;
		}
		return metadata.scope === "user" ? `User (${formatBaseDir(agentDir)})` : `Project (${CONFIG_DIR_NAME}/)`;
	}
	return metadata.scope === "user" ? "User settings" : "Project settings";
}

export function buildGroups(resolved: ResolvedPaths, agentDir: string): ResourceGroup[] {
	const groupMap = new Map<string, ResourceGroup>();

	const addToGroup = (resources: ResolvedResource[], resourceType: ResourceType) => {
		for (const res of resources) {
			const { path, enabled, metadata } = res;
			const groupKey = `${metadata.origin}:${metadata.scope}:${metadata.source}:${metadata.baseDir ?? ""}`;

			if (!groupMap.has(groupKey)) {
				groupMap.set(groupKey, {
					key: groupKey,
					label: getGroupLabel(metadata, agentDir),
					scope: metadata.scope,
					origin: metadata.origin,
					source: metadata.source,
					subgroups: [],
				});
			}

			const group = groupMap.get(groupKey)!;
			const subgroupKey = `${groupKey}:${resourceType}`;

			let subgroup = group.subgroups.find((sg) => sg.type === resourceType);
			if (!subgroup) {
				subgroup = {
					type: resourceType,
					label: RESOURCE_TYPE_LABELS[resourceType],
					items: [],
				};
				group.subgroups.push(subgroup);
			}

			const fileName = basename(path);
			const parentFolder = basename(dirname(path));
			let displayName: string;
			if (resourceType === "skills" && fileName === "SKILL.md") {
				displayName = parentFolder;
			} else {
				displayName = fileName;
			}
			subgroup.items.push({
				path,
				enabled,
				metadata,
				resourceType,
				displayName,
				groupKey,
				subgroupKey,
			});
		}
	};

	addToGroup(resolved.skills, "skills");
	addToGroup(resolved.prompts, "prompts");
	addToGroup(resolved.themes, "themes");

	// Sort groups: packages first, then top-level; user before project
	const groups = Array.from(groupMap.values());
	groups.sort((a, b) => {
		if (a.origin !== b.origin) {
			return a.origin === "package" ? -1 : 1;
		}
		if (a.scope !== b.scope) {
			return a.scope === "user" ? -1 : 1;
		}
		return a.source.localeCompare(b.source);
	});

	// Sort subgroups within each group by type order, and items by name
	const typeOrder: Record<ResourceType, number> = { skills: 0, prompts: 1, themes: 2 };
	for (const group of groups) {
		group.subgroups.sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);
		for (const subgroup of group.subgroups) {
			subgroup.items.sort((a, b) => a.displayName.localeCompare(b.displayName));
		}
	}

	return groups;
}
