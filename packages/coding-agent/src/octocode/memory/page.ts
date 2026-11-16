/** `/memory` in the terminal: the shared list → detail → action pages (commands design §3). */

import type { ExtensionCommandContext } from "../../core/features/index.ts";
import { type PageRow, type PageSection, showCommandPage } from "../shared/page.ts";
import { memoryLabel } from "./query.ts";
import { type Memory, memoryAge } from "./store.ts";

/** The row that opens the add editor. */
export const ADD_ROW = "add";

/** Where a memory is listed: pinned first, then by scope. */
export const sectionOf = (memory: Memory): "Pinned" | "Workspace" | "Project" | "Global" =>
	memory.pinned
		? "Pinned"
		: memory.scope === "workspace"
			? "Workspace"
			: memory.scope === "project"
				? "Project"
				: "Global";

const row = (memory: Memory): PageRow => ({
	id: String(memory.id),
	name: memoryLabel(memory.id),
	detail: memory.title,
	badge: memory.kind,
	tone: "muted",
});

/** The memories (already grouped) by section, then "+ Add". Resolves with a memory id, `ADD_ROW`, or undefined on Escape. */
export async function memoryListPage(
	ctx: ExtensionCommandContext,
	memories: readonly Memory[],
	title: string,
	initialId?: string,
): Promise<string | undefined> {
	const sections: PageSection[] = [];
	for (const heading of ["Pinned", "Workspace", "Project", "Global"] as const) {
		const rows = memories.filter((memory) => sectionOf(memory) === heading).map(row);
		if (rows.length) sections.push({ heading, rows });
	}
	if (!sections.length) sections.push({ heading: "Memories", rows: [], empty: "none yet — choose Add below" });
	sections.push({ heading: "Add", rows: [{ id: ADD_ROW, name: "+ Add a memory", detail: "write a durable note" }] });
	const choice = await showCommandPage(ctx.ui, {
		title: `Memories — ${title}`,
		sections,
		initialId,
	});
	return choice?.id;
}

/** One memory: facts above its actions. Resolves with the chosen action, or undefined on Escape. */
export async function memoryDetailPage(
	ctx: ExtensionCommandContext,
	memory: Memory,
	actions: readonly string[],
): Promise<string | undefined> {
	const choice = await showCommandPage(ctx.ui, {
		title: `${memoryLabel(memory.id)} ${memory.title}`,
		facts: [
			{ label: "Scope", value: `${memory.scope}${memory.pinned ? " · pinned" : ""}` },
			{ label: "Kind", value: memory.kind },
			{ label: "Keywords", value: memory.keywords || "none" },
			{
				label: "Used",
				value: `${memory.useCount} ${memory.useCount === 1 ? "time" : "times"} · updated ${memoryAge(memory)} ago`,
			},
		],
		sections: [{ heading: "Actions", rows: actions.map((name) => ({ id: name, name })) }],
		nested: true,
	});
	return choice?.id;
}
