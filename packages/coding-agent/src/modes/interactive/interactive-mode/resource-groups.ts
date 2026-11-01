/**
 * Groups loaded resources by scope and package source, and formats resource diagnostics such as name collisions.
 */

import { GLYPH } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import type { ResourceDiagnostic } from "../../../core/resource-loader.ts";
import type { SourceInfo } from "../../../core/source-info.ts";
import { STATE_COLOR } from "../../../theme/status.ts";
import { theme } from "../../../theme/theme.ts";
import type { InteractiveModeHost } from "./host.ts";
import type { ScopeGroup, ScopeGroupFormatOptions, ScopeGroupName, SourcedPath } from "./types.ts";

/** Interactive-mode members used by the resource groups and diagnostics. */
type ResourceGroupsHost = Pick<
	InteractiveModeHost,
	"formatDisplayPath" | "getScopeGroup" | "getShortPath" | "isPackageSource"
>;

function getDisplaySourceInfo(sourceInfo?: SourceInfo): {
	label: string;
	scopeLabel?: string;
	color: "accent" | "muted";
} {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (source === "local") {
		if (scope === "user") {
			return { label: "user", color: "muted" };
		}
		if (scope === "project") {
			return { label: "project", color: "muted" };
		}
		if (scope === "temporary") {
			return { label: "path", scopeLabel: "temp", color: "muted" };
		}
		return { label: "path", color: "muted" };
	}

	if (source === "cli") {
		return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
	}

	const scopeLabel =
		scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
	return { label: source, scopeLabel, color: "accent" };
}

export function getScopeGroup(sourceInfo?: SourceInfo): ScopeGroupName {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (source === "cli" || scope === "temporary") return "path";
	if (scope === "user") return "user";
	if (scope === "project") return "project";
	return "path";
}

export function isPackageSource(sourceInfo?: SourceInfo): boolean {
	const source = sourceInfo?.source ?? "";
	return source.startsWith("npm:") || source.startsWith("git:");
}

export function buildScopeGroups(host: ResourceGroupsHost, items: SourcedPath[]): ScopeGroup[] {
	const groups: Record<ScopeGroupName, ScopeGroup> = {
		user: { scope: "user", paths: [], packages: new Map() },
		project: { scope: "project", paths: [], packages: new Map() },
		path: { scope: "path", paths: [], packages: new Map() },
	};

	for (const item of items) {
		const groupKey = host.getScopeGroup(item.sourceInfo);
		const group = groups[groupKey];
		const source = item.sourceInfo?.source ?? "local";

		if (host.isPackageSource(item.sourceInfo)) {
			const list = group.packages.get(source) ?? [];
			list.push(item);
			group.packages.set(source, list);
		} else {
			group.paths.push(item);
		}
	}

	return [groups.project, groups.user, groups.path].filter(
		(group) => group.paths.length > 0 || group.packages.size > 0,
	);
}

export function formatScopeGroups(groups: ScopeGroup[], options: ScopeGroupFormatOptions): string {
	const lines: string[] = [];

	for (const group of groups) {
		lines.push(`  ${theme.fg("accent", group.scope)}`);

		const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
		for (const item of sortedPaths) {
			lines.push(theme.fg("dim", `    ${sanitizeTerminalText(options.formatPath(item))}`));
		}

		const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
		for (const [source, items] of sortedPackages) {
			lines.push(`    ${theme.fg("mdLink", sanitizeTerminalText(source))}`);
			const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPackagePaths) {
				lines.push(theme.fg("dim", `      ${sanitizeTerminalText(options.formatPackagePath(item, source))}`));
			}
		}
	}

	return lines.join("\n");
}

function findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
	const exact = sourceInfos.get(p);
	if (exact) return exact;

	let current = p;
	while (current.includes("/")) {
		current = current.substring(0, current.lastIndexOf("/"));
		const parent = sourceInfos.get(current);
		if (parent) return parent;
	}

	return undefined;
}

/** Paths and source names come from the file system and package data, so they are shown without terminal controls. */
function formatPathWithSource(host: ResourceGroupsHost, p: string, sourceInfo?: SourceInfo): string {
	if (sourceInfo) {
		const shortPath = host.getShortPath(p, sourceInfo);
		const { label, scopeLabel } = getDisplaySourceInfo(sourceInfo);
		const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
		return sanitizeTerminalText(`${labelText} ${shortPath}`);
	}
	return sanitizeTerminalText(host.formatDisplayPath(p));
}

export function formatDiagnostics(
	host: ResourceGroupsHost,
	diagnostics: readonly ResourceDiagnostic[],
	sourceInfos: Map<string, SourceInfo>,
): string {
	const lines: string[] = [];

	// Group collision diagnostics by name
	const collisions = new Map<string, ResourceDiagnostic[]>();
	const otherDiagnostics: ResourceDiagnostic[] = [];

	for (const d of diagnostics) {
		if (d.type === "collision" && d.collision) {
			const list = collisions.get(d.collision.name) ?? [];
			list.push(d);
			collisions.set(d.collision.name, list);
		} else {
			otherDiagnostics.push(d);
		}
	}

	// Format collision diagnostics grouped by name
	for (const [name, collisionList] of collisions) {
		const first = collisionList[0]?.collision;
		if (!first) continue;
		lines.push(theme.fg("warning", `  "${sanitizeTerminalText(name)}" collision:`));
		lines.push(
			theme.fg(
				"dim",
				`    ${theme.fg(STATE_COLOR.done, GLYPH.done)} ${formatPathWithSource(host, first.winnerPath, findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
			),
		);
		for (const d of collisionList) {
			if (d.collision) {
				lines.push(
					theme.fg(
						"dim",
						`    ${theme.fg(STATE_COLOR.stopped, GLYPH.stopped)} ${formatPathWithSource(host, d.collision.loserPath, findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
					),
				);
			}
		}
	}

	for (const d of otherDiagnostics) {
		const message = sanitizeTerminalText(d.message);
		if (d.path) {
			const formattedPath = formatPathWithSource(host, d.path, findSourceInfoForPath(d.path, sourceInfos));
			lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
			lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${message}`));
		} else {
			lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${message}`));
		}
	}

	return lines.join("\n");
}
