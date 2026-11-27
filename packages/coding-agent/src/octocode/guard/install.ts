import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { installSkillReviewer } from "../../core/skill-review.ts";
import { skillItem } from "./items.ts";
import { enforces, recordGate } from "./registry.ts";
import { gate, scopeFor } from "./store.ts";

/**
 * Installs the feature guard's skill reviewer into core (imported for its effect at the CLI entry). A workspace or
 * global skill stays off until the user approved every file of its folder.
 */
installSkillReviewer((skills, cwd, shipped) => {
	const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false }).getGlobalSettings();
	const enforce = enforces(settings, "skill");
	const items = skills.map((skill) =>
		skillItem({
			name: skill.name,
			filePath: skill.filePath,
			scope: skill.category === "workspace" ? scopeFor(skill.filePath, cwd) : "global",
			bundledNames: shipped,
		}),
	);
	const result = gate("skill", items, { enforce });
	recordGate("skill", result, enforce);
	const off = new Set<string>();
	items.forEach((item, index) => {
		if (!result.allowed.has(item.id)) off.add(skills[index]?.filePath ?? "");
	});
	return off;
});
