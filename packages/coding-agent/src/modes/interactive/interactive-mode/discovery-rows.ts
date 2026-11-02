/**
 * Rows of the startup listing from the loaded-context view (`core/discovery/context-view.ts`): one per kind, each with the
 * sources the items came from, what did not apply, and (expanded) every item with its path. Pure: the view in, specs out.
 */

import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import {
	type ContextEntry,
	type ContextGroup,
	type ContextView,
	PI_CODE_HINT,
	activeEntries,
	problemSummary,
	sourceSummary,
} from "../../../core/discovery/context-view.ts";
import { theme } from "../../../theme/theme.ts";
import type { LoadedRowSpec } from "./loaded-row.ts";

export interface ViewRow {
	/** The group id (`skill`, `context`, ...), or `warning`. */
	id: string;
	spec: LoadedRowSpec;
}

const clean = (text: string) => sanitizeTerminalText(text).trim();

function entryLine(entry: ContextEntry, formatPath: (path: string) => string): string {
	const name = clean(entry.name);
	const path = theme.fg("dim", clean(formatPath(entry.path)));
	if (entry.state === "loaded")
		return `    ${name}  ${path}${entry.note ? theme.fg("dim", ` (${clean(entry.note)})`) : ""}`;
	return `    ${name}  ${path}${entry.note ? theme.fg("warning", ` (${clean(entry.note)})`) : ""}`;
}

/** Items grouped under their source, in the order the sources first appear. */
function groupDetails(group: ContextGroup, formatPath: (path: string) => string): string {
	const bySource = new Map<string, ContextEntry[]>();
	for (const entry of group.entries) bySource.set(entry.source, [...(bySource.get(entry.source) ?? []), entry]);
	return [...bySource]
		.flatMap(([source, entries]) => [
			`  ${theme.fg("accent", clean(source))}`,
			...entries.map((entry) => entryLine(entry, formatPath)),
		])
		.concat(group.id === "extension" ? [`  ${theme.fg("dim", PI_CODE_HINT)}`] : [])
		.join("\n");
}

function groupRow(group: ContextGroup, formatPath: (path: string) => string): ViewRow {
	return {
		id: group.id,
		spec: {
			label: group.title,
			count: () => activeEntries(group).length,
			summary: () => theme.fg("dim", clean(sourceSummary(group))),
			cells: () => ({
				sources: theme.fg("dim", clean(sourceSummary(group))),
				tail: theme.fg("warning", problemSummary(group)),
			}),
			details: () => groupDetails(group, formatPath),
		},
	};
}

/** Every kind with something to show, in the view's order, then one Warnings row for shadowed copies and untrusted items. */
export function viewRows(view: ContextView, formatPath: (path: string) => string): ViewRow[] {
	const rows = view.groups.map((group) => groupRow(group, formatPath));
	if (view.warnings.length > 0) {
		const text = () => clean(view.warnings.map((warning) => warning.short).join(" \u00b7 "));
		rows.push({
			id: "warning",
			spec: {
				label: "Warnings",
				count: () => view.warnings.reduce((sum, warning) => sum + warning.details.length, 0),
				summary: () => theme.fg("warning", text()),
				cells: () => ({ sources: theme.fg("warning", text()) }),
				details: () =>
					view.warnings
						.flatMap((warning) => [
							`  ${theme.fg("warning", clean(warning.text))}`,
							...warning.details.map((detail) => theme.fg("dim", `    ${clean(detail)}`)),
						])
						.join("\n"),
			},
		});
	}
	return rows;
}
