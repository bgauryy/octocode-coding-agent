import { wrapTextWithAnsi } from "@octocodeai/octocode-tui/text";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { blockedReason, type SwitchScope } from "../../core/extensibility/switch.ts";
import type { Theme } from "../../theme/theme.ts";
import { HOST_TITLES, type InventoryItem } from "./inventory.ts";
import { type OverviewRow, overviewRows } from "./overview.ts";
import { HARNESS_SECTIONS, type HarnessSection, sectionCount, sectionOf } from "./sections.ts";

export type Row =
	| { type: "host"; title: string }
	| { type: "item"; item: InventoryItem }
	| { type: "section"; row: OverviewRow };

/**
 * The rows a section lists. The Overview lists one row per section. Hooks, sources and extensions group under their
 * host's heading. A filter matches label, id and detail; without one, a hook shows only inside an open hook file.
 */
export function pickerRows(
	items: readonly InventoryItem[],
	section: HarnessSection,
	query: string,
	expanded: ReadonlySet<string>,
): Row[] {
	if (section === "overview") return overviewRows(items).map((row) => ({ type: "section", row }));
	const matches = items.filter(
		(item) =>
			sectionOf(item) === section &&
			(query
				? [item.label, item.id, item.detail].some((text) => text.toLowerCase().includes(query))
				: item.kind !== "hook" || expanded.has(item.parents?.[0] ?? "")),
	);
	if (section !== "hooks" && section !== "sources" && section !== "extensions")
		return matches.map((item) => ({ type: "item", item }));
	return (Object.keys(HOST_TITLES) as InventoryItem["host"][]).flatMap((host) => {
		const own = matches.filter((item) => item.host === host);
		return own.length
			? [{ type: "host" as const, title: HOST_TITLES[host] }, ...own.map((item) => ({ type: "item" as const, item }))]
			: [];
	});
}

/** The section names across the top, the open one highlighted; counts show `…` while the inventory loads. */
export function sectionNav(items: readonly InventoryItem[], active: HarnessSection, ready: boolean, t: Theme): string {
	return (Object.keys(HARNESS_SECTIONS) as HarnessSection[])
		.map((section) => {
			const count = ready ? sectionCount(items, section) : "…";
			const label =
				section === "overview" ? HARNESS_SECTIONS[section].title : `${HARNESS_SECTIONS[section].title} (${count})`;
			return section === active ? t.fg("accent", t.bold(label)) : t.fg("muted", label);
		})
		.join(" · ");
}

/** The full-detail lines of one row, wrapped to `width`. */
export function itemDetailLines(
	item: InventoryItem,
	scope: SwitchScope,
	scopePath: string,
	width: number,
	hasTools: boolean,
): string[] {
	const reason = blockedReason(item, scope);
	return [
		`${item.label} · switch ${item.on ? "on" : "off"}`,
		item.detail,
		`ID: ${item.id}`,
		`Switch scope: ${scope} · writes ${scopePath}`,
		...(item.kind === "hook-file" || item.kind === "hook" ? ["Hook files: → opens handlers; ← closes them."] : []),
		...(hasTools ? ["Enter or → opens this server's tools and who gets it; Space switches the server."] : []),
		...(reason ? [`Restriction: ${reason}`] : []),
	].flatMap((line) => wrapTextWithAnsi(sanitizeTerminalText(line), Math.max(1, width - 2)));
}

/** One list row: cursor, indentation, fold marker, switch box, label and a short brief. */
export function itemRowLine(
	item: InventoryItem,
	state: { selected: boolean; scope: SwitchScope; expanded: boolean },
	t: Theme,
): string {
	const box = item.locked ? t.fg("warning", "[-]") : item.on ? t.fg("success", "[x]") : t.fg("dim", "[ ]");
	const label = sanitizeTerminalText(item.label);
	const name = blockedReason(item, state.scope) ? t.fg("dim", label) : state.selected ? t.bold(label) : label;
	const brief =
		item.kind === "hook" ? (item.gate ? "gate" : "") : item.kind === "mcp" ? item.detail : item.detail.split(" · ")[0];
	const fold = item.kind === "hook-file" && !item.locked ? (state.expanded ? "▾ " : "▸ ") : "";
	return `${state.selected ? t.fg("accent", "> ") : "  "}${"  ".repeat(item.depth)}${fold}${box} ${name}${brief ? t.fg("dim", `  ${sanitizeTerminalText(brief)}`) : ""}`;
}
