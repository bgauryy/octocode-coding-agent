/**
 * Rows of the startup listing from the loaded-context view (`core/discovery/context-view.ts`): one per kind, each with the
 * sources the items came from, what did not apply, and (expanded) every item with its path. Pure: the view in, specs out.
 */

import { plural } from "@octocodeai/octocode-common/clip";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { ResourceDiagnostic } from "../../../core/diagnostics.ts";
import {
	type ContextEntry,
	type ContextGroup,
	type ContextView,
	type ContextWarning,
	PI_CODE_HINT,
	activeEntries,
	problemSummary,
	sourceSummary,
} from "../../../core/discovery/context-view.ts";
import { skillFolder } from "../../../core/discovery/display-paths.ts";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import type { KeybindingProblem } from "../../../core/keybindings.ts";
import type { HarnessStatus } from "../../../core/discovery/vendors/types.ts";
import { visibleWidth } from "@octocodeai/octocode-tui";
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

export interface ListingBudget {
	chars: number;
	budget: number;
}
const size = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
function groupRow(group: ContextGroup, formatPath: (path: string) => string, budget?: ListingBudget): ViewRow {
	const problems = problemSummary(group);
	const summary = () =>
		[
			budget
				? `${size(budget.chars)}/${size(budget.budget)} chars${group.id === "context" ? ` · ${sourceSummary(group)}` : ""}`
				: sourceSummary(group),
			problems,
			group.id === "skill"
				? "octocode context check · /harness"
				: group.id === "context"
					? "octocode context check"
					: "/harness",
		]
			.filter(Boolean)
			.join(" · ");
	return {
		id: group.id,
		spec: {
			label: group.title,
			state: () =>
				(budget && budget.chars > budget.budget) || /duplicate|not trusted/.test(problems)
					? "attention"
					: activeEntries(group).length
						? "ready"
						: "off",
			count: () => activeEntries(group).length,
			summary: () => theme.fg("dim", clean(summary())),
			cells: () => ({
				sources: theme.fg("dim", clean(sourceSummary(group))),
				tail: theme.fg("warning", problemSummary(group)),
			}),
			details: () => groupDetails(group, formatPath),
		},
	};
}

/** Every kind with something to show, in the view's order; the view's warnings are lines of their own ({@link startupWarnings}). */
export function viewRows(
	view: ContextView,
	formatPath: (path: string) => string,
	budgets: Record<string, ListingBudget> = {},
): ViewRow[] {
	return view.groups.map((group) => groupRow(group, formatPath, budgets[group.id]));
}

/**
 * `Harness ✓ 2  on: .agents, Pi · off: Claude Code · /harness`: every switchable harness, grouped on and off; the
 * count is how many are on. Octocode itself has no switch and is left out. When the line does not fit, the groups wrap;
 * `/harness` always ends it.
 */
export function harnessRow(statuses: readonly HarnessStatus[]): LoadedRowSpec {
	const shown = statuses.filter((status) => status.switchable);
	const names = (on: boolean) =>
		shown
			.filter((status) => status.on === on)
			.map((status) => `${clean(status.label)}${on && status.projectOnly ? " (project)" : ""}`);
	const parts = () => {
		const [on, off] = [names(true), names(false)];
		return [
			...(on.length ? [theme.fg("muted", `on: ${on.join(", ")}`)] : []),
			...(off.length ? [theme.fg("dim", `off: ${off.join(", ")}`)] : []),
			theme.fg("dim", "/harness"),
		];
	};
	const separator = theme.fg("dim", " \u00b7 ");
	return {
		label: "Harness",
		state: () => (shown.some((s) => s.on) ? "ready" : "off"),
		count: () => shown.filter((status) => status.on).length,
		showZero: true,
		summary: () => parts().join(separator),
		fitSummary: (room) => {
			const full = parts().join(separator);
			if (visibleWidth(full) <= room) return [full];
			// Whole harnesses per line; a wrapped line ends with ` ·`, so all but the last part keep two cells for it.
			const short = parts();
			const lines: string[] = [];
			for (const [index, part] of short.entries()) {
				const reserve = index === short.length - 1 ? 0 : 2;
				const last = lines.length - 1;
				if (last < 0) lines.push(part);
				else if (visibleWidth(lines[last] + separator + part) + reserve <= room) lines[last] += separator + part;
				else {
					lines[last] += theme.fg("dim", " \u00b7");
					lines.push(part);
				}
			}
			return lines;
		},
	};
}

/** A Codex `agents/openai.yaml` note: metadata this host reads but does not act on, information rather than a problem. */
const isCodexNote = (diagnostic: ResourceDiagnostic): boolean =>
	/[\\/]agents[\\/]openai\.yaml$/.test(diagnostic.path ?? "");

/**
 * The startup warnings, one line each saying what is wrong and what to do (`details` are listed by ctrl+o), and the
 * notes shown only expanded: skipped duplicates (discovery's shadowed copies, then loader collisions of other names),
 * skill files with problems, and keybinding entries the loader ignores. Codex metadata notes are information.
 */
export function startupWarnings(
	view: ContextView,
	skillDiagnostics: readonly ResourceDiagnostic[],
	keybindings: readonly KeybindingProblem[],
): { warnings: ContextWarning[]; notes: ContextWarning[] } {
	const shadowedSkills = new Set(
		view.groups
			.filter((group) => group.id === "skill")
			.flatMap((group) => group.entries.filter((entry) => entry.state === "shadowed").map((entry) => entry.name)),
	);
	const collisions = skillDiagnostics.filter(
		(d) => d.type === "collision" && d.collision && !shadowedSkills.has(d.collision.name),
	);
	const notes = skillDiagnostics.filter(isCodexNote);
	const problems = skillDiagnostics.filter((d) => d.type !== "collision" && !isCodexNote(d));
	const line = (d: ResourceDiagnostic) => `${d.path ? `${homeTilde(d.path)}: ` : ""}${d.message}`;
	const warnings: ContextWarning[] = [...view.warnings];
	const winner = collisions[0]?.collision?.winnerPath;
	if (collisions.length > 0 && winner)
		warnings.push({
			text: `${plural(collisions.length, "duplicate skill", "duplicate skills")} skipped, kept ${skillFolder(winner)} (ctrl+o lists)`,
			details: collisions.map((d) => `${d.collision?.name}: ${homeTilde(d.collision?.loserPath ?? "")}`),
		});
	const problemFiles = new Set(problems.map((d) => d.path ?? d.message));
	if (problems.length > 0)
		warnings.push({
			text: `${plural(problemFiles.size, "skill file", "skill files")} with problems: invalid SKILL.md or folder (ctrl+o lists)`,
			details: problems.map(line),
		});
	for (const { path, problem } of keybindings) warnings.push({ text: `${homeTilde(path)}: ${problem}`, details: [] });
	return {
		warnings,
		notes:
			notes.length > 0
				? [
						{
							text: `${plural(notes.length, "Codex agents/openai.yaml file", "Codex agents/openai.yaml files")}: read and validated; this host does not use their metadata`,
							details: notes.map(line),
						},
					]
				: [],
	};
}
