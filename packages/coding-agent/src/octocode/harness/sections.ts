import type { InventoryItem } from "./inventory.ts";

export const HARNESS_SECTIONS = {
	overview: {
		title: "Overview",
		empty: "",
	},
	skills: {
		title: "Skills",
		empty: "No skills found. Add a SKILL.md under .agents/skills/ or enable a source in Sources.",
	},
	mcp: {
		title: "MCPs",
		empty:
			"No MCP servers configured. Add one with /mcp add (soon: an Add action in this list); /mcp shows connections.",
	},
	hooks: {
		title: "Hooks",
		empty: "No hooks found. Add a hook file such as .octocode/hooks.json; /harness hooks shows what is loaded.",
	},
	sources: {
		title: "Sources",
		empty:
			"No harness or plugin sources found. Add a plugin with /harness install <plugin@marketplace>; /harness config shows loaded configuration.",
	},
	extensions: {
		title: "Extensions",
		empty: "No extensions found. Add an extension in settings.json, then run /reload.",
	},
} as const;
export type HarnessSection = keyof typeof HARNESS_SECTIONS;
/** The sections that list items; Overview only summarises them. */
export type ItemSection = Exclude<HarnessSection, "overview">;
export const ITEM_SECTIONS = Object.keys(HARNESS_SECTIONS).filter((name) => name !== "overview") as ItemSection[];
export const sectionOf = (item: InventoryItem): ItemSection =>
	item.kind === "skill"
		? "skills"
		: item.kind === "mcp"
			? "mcp"
			: item.kind === "hooks" || item.kind === "hook-file" || item.kind === "hook"
				? "hooks"
				: item.kind === "extension"
					? "extensions"
					: "sources";

/** The rows a section counts: hooks count handlers, not their files. */
export function sectionItems(items: readonly InventoryItem[], section: ItemSection): InventoryItem[] {
	return items.filter((item) => sectionOf(item) === section && (section !== "hooks" || item.kind === "hook"));
}
export function sectionCount(items: readonly InventoryItem[], section: HarnessSection): number {
	return section === "overview" ? 0 : sectionItems(items, section).length;
}
