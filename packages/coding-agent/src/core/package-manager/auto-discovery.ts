import { dirname, join, resolve } from "node:path";
import type { SettingsManager } from "../settings-manager.ts";
import { collectAutoExtensionEntries, collectAutoPromptEntries, collectAutoThemeEntries } from "./auto-entries.ts";
import {
	collectAncestorAgentsSkillDirs,
	collectAncestorProjectSkillDirs,
	collectAutoSkillEntries,
} from "./discovery.ts";
import { isEnabledByOverrides } from "./patterns.ts";
import { addResource, getTargetMap } from "./resources.ts";
import {
	getHomeDir,
	type PackageManagerHost,
	type PathMetadata,
	type ResourceAccumulator,
	type ResourceType,
} from "./types.ts";

export function addAutoDiscoveredResources(
	host: PackageManagerHost,
	accumulator: ResourceAccumulator,
	globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
	projectSettings: ReturnType<SettingsManager["getProjectSettings"]>,
	globalBaseDir: string,
	projectBaseDir: string,
): void {
	const userMetadata: PathMetadata = {
		source: "auto",
		scope: "user",
		origin: "top-level",
		baseDir: globalBaseDir,
	};
	const projectMetadata: PathMetadata = {
		source: "auto",
		scope: "project",
		origin: "top-level",
		baseDir: projectBaseDir,
	};

	const userOverrides = {
		extensions: globalSettings.extensions ?? [],
		skills: globalSettings.skills ?? [],
		prompts: globalSettings.prompts ?? [],
		themes: globalSettings.themes ?? [],
	};
	const projectOverrides = {
		extensions: projectSettings.extensions ?? [],
		skills: projectSettings.skills ?? [],
		prompts: projectSettings.prompts ?? [],
		themes: projectSettings.themes ?? [],
	};

	const userDirs = {
		extensions: join(globalBaseDir, "extensions"),
		skills: join(globalBaseDir, "skills"),
		prompts: join(globalBaseDir, "prompts"),
		themes: join(globalBaseDir, "themes"),
	};
	const projectDirs = {
		extensions: join(projectBaseDir, "extensions"),
		skills: join(projectBaseDir, "skills"),
		prompts: join(projectBaseDir, "prompts"),
		themes: join(projectBaseDir, "themes"),
	};
	const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
	const projectTrusted = host.settingsManager.isProjectTrusted();
	const projectAgentsSkillDirs = projectTrusted
		? collectAncestorAgentsSkillDirs(host.cwd).filter((dir) => resolve(dir) !== resolve(userAgentsSkillsDir))
		: [];

	const addResources = (
		resourceType: ResourceType,
		paths: string[],
		metadata: PathMetadata,
		overrides: string[],
		baseDir: string,
	) => {
		const target = getTargetMap(accumulator, resourceType);
		for (const path of paths) {
			const enabled = isEnabledByOverrides(path, overrides, baseDir);
			addResource(target, path, metadata, enabled);
		}
	};

	if (projectTrusted) {
		// Project extensions from .octocode/
		addResources(
			"extensions",
			collectAutoExtensionEntries(projectDirs.extensions),
			projectMetadata,
			projectOverrides.extensions,
			projectBaseDir,
		);

		// Project skills from .octocode/
		addResources(
			"skills",
			collectAutoSkillEntries(projectDirs.skills, "octocode"),
			projectMetadata,
			projectOverrides.skills,
			projectBaseDir,
		);
		// From a subdirectory, the repository root's .octocode/ skills are project skills too.
		for (const skillsDir of collectAncestorProjectSkillDirs(host.cwd)) {
			const baseDir = dirname(skillsDir);
			addResources(
				"skills",
				collectAutoSkillEntries(skillsDir, "octocode"),
				{ ...projectMetadata, baseDir },
				projectOverrides.skills,
				baseDir,
			);
		}
	}

	// Project skills from .agents/ (each with its own baseDir)
	for (const agentsSkillsDir of projectAgentsSkillDirs) {
		const agentsBaseDir = dirname(agentsSkillsDir); // the .agents directory
		const agentsMetadata: PathMetadata = {
			...projectMetadata,
			baseDir: agentsBaseDir,
		};
		addResources(
			"skills",
			collectAutoSkillEntries(agentsSkillsDir, "agents"),
			agentsMetadata,
			projectOverrides.skills,
			agentsBaseDir,
		);
	}

	if (projectTrusted) {
		addResources(
			"prompts",
			collectAutoPromptEntries(projectDirs.prompts),
			projectMetadata,
			projectOverrides.prompts,
			projectBaseDir,
		);
		addResources(
			"themes",
			collectAutoThemeEntries(projectDirs.themes),
			projectMetadata,
			projectOverrides.themes,
			projectBaseDir,
		);
	}

	// User extensions from ~/.octocode/agent/
	addResources(
		"extensions",
		collectAutoExtensionEntries(userDirs.extensions),
		userMetadata,
		userOverrides.extensions,
		globalBaseDir,
	);

	// User skills from ~/.octocode/agent/
	addResources(
		"skills",
		collectAutoSkillEntries(userDirs.skills, "octocode"),
		userMetadata,
		userOverrides.skills,
		globalBaseDir,
	);

	// User skills from ~/.agents/ (with its own baseDir)
	const userAgentsBaseDir = dirname(userAgentsSkillsDir);
	const userAgentsMetadata: PathMetadata = {
		...userMetadata,
		baseDir: userAgentsBaseDir,
	};
	addResources(
		"skills",
		collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
		userAgentsMetadata,
		userOverrides.skills,
		userAgentsBaseDir,
	);

	addResources(
		"prompts",
		collectAutoPromptEntries(userDirs.prompts),
		userMetadata,
		userOverrides.prompts,
		globalBaseDir,
	);
	addResources("themes", collectAutoThemeEntries(userDirs.themes), userMetadata, userOverrides.themes, globalBaseDir);
}
