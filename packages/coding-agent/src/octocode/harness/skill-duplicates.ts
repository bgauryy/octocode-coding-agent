import path from "node:path";
import type { InventoryItem } from "../../core/extensibility/inventory-types.ts";
import { skillPathPrecedence } from "../../core/resource-loader/skill-precedence.ts";
import { chooseSkillWinner, type SkillPrecedence } from "../../core/skills.ts";

/** The source named at the start of a row's detail (`Octocode (collection)`). */
const sourceOf = (item: InventoryItem): string => item.detail.split(" · ")[0] || item.label;

/**
 * Marks each switched-on skill row that loses its name to another on row, with the rule the loader applies
 * (`chooseSkillWinner`): the row stays on because its own switch is on, but the session does not load it.
 */
export function markLosingSkills(items: InventoryItem[], agentDir: string): InventoryItem[] {
	const byName = new Map<string, { item: InventoryItem; rank: SkillPrecedence | undefined }[]>();
	for (const item of items) {
		if (item.kind !== "skill" || !item.on) continue;
		const rank = item.resource
			? skillPathPrecedence(item.resource.path, {
					metadataByPath: new Map([[path.resolve(item.resource.path), item.resource.metadata]]),
					extensionPaths: new Set(),
					agentDir,
				})
			: "replaceable";
		const name = item.name ?? item.label;
		byName.set(name, [...(byName.get(name) ?? []), { item, rank }]);
	}
	const winners = new Map<InventoryItem, InventoryItem>();
	for (const candidates of byName.values()) {
		if (candidates.length < 2) continue;
		const winner = chooseSkillWinner(candidates).item;
		for (const { item } of candidates) if (item !== winner) winners.set(item, winner);
	}
	return items.map((item) => {
		const winner = winners.get(item);
		return winner ? { ...item, detail: `not loaded: ${sourceOf(winner)} wins · ${item.detail}` } : item;
	});
}
