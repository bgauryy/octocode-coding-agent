/**
 * The startup listing of loaded context files, skills, MCP servers, prompts and extensions (one aligned row each, with
 * a count; ctrl+o lists the items), followed by resource diagnostics.
 */

import {
	type Component,
	type Container,
	ELLIPSIS,
	GLYPH,
	SEPARATOR,
	Spacer,
	type StateSource,
	type UiState,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import { getMcpSessionStatus, MCP_STATUS_EVENT } from "../../../../../mcp/src/status.ts";
import type { EventBus } from "@octocodeai/octocode-agent-core";
import type { ResourceDiagnostic } from "../../../core/resource-loader.ts";
import type { SourceInfo } from "../../../core/source-info.ts";
import { keyHint } from "../components/keybinding-hints.ts";
import { ThemedText } from "../components/themed-text.ts";
import { STATE_COLOR } from "../../../theme/status.ts";
import { theme } from "../../../theme/theme.ts";
import { ExpandableText } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import { LoadedRow, type LoadedRowSpec, loadedColumns } from "./loaded-row.ts";
import type { SourcedPath } from "./types.ts";

/** Interactive-mode members used by the loaded-resources listing. */
type LoadedResourcesHost = Pick<
	InteractiveModeHost,
	| "buildScopeGroups"
	| "formatContextPath"
	| "formatDiagnostics"
	| "formatDisplayPath"
	| "formatExtensionDisplayPath"
	| "formatScopeGroups"
	| "getBuiltInCommandConflictDiagnostics"
	| "getCompactExtensionLabels"
	| "getShortPath"
	| "getStartupExpansionState"
	| "loadedResourcesContainer"
	| "session"
	| "shouldShowStartupDetails"
	| "ui"
>;

/** Stops the live rows of the listing (their state subscriptions); call before clearing it or at shutdown. */
export function disposeLoadedResources(container: Container): void {
	for (const child of container.children) (child as { dispose?(): void }).dispose?.();
}

export function showLoadedResources(
	host: LoadedResourcesHost,
	options?: {
		extensions?: SourcedPath[];
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	},
): void {
	// Resource rendering is idempotent; chat clears no longer clear this separate container.
	disposeLoadedResources(host.loadedResourcesContainer);
	host.loadedResourcesContainer.clear();

	const showListing = options?.force || host.shouldShowStartupDetails();
	const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
	if (!showListing && !showDiagnostics) {
		return;
	}

	const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
		// Labels are file and package names: untrusted text, shown without terminal controls.
		const labels = items.map((item) => sanitizeTerminalText(item).trim()).filter((item) => item.length > 0);
		if (options?.sort !== false) {
			labels.sort((a, b) => a.localeCompare(b));
		}
		return theme.fg("dim", labels.join(", "));
	};
	const listHint = () => keyHint("app.tools.expand", "to list");

	const skillsResult = host.session.resourceLoader.getSkills();
	const promptsResult = host.session.resourceLoader.getPrompts();
	const themesResult = host.session.resourceLoader.getThemes();
	const extensions =
		options?.extensions ??
		host.session.resourceLoader
			.getExtensions()
			.extensions.filter((extension) => !extension.hidden)
			.map((extension) => ({
				path: extension.path,
				sourceInfo: extension.sourceInfo,
			}));
	const sourceInfos = new Map<string, SourceInfo>();
	for (const extension of extensions) {
		if (extension.sourceInfo) {
			sourceInfos.set(extension.path, extension.sourceInfo);
		}
	}
	for (const skill of skillsResult.skills) {
		if (skill.sourceInfo) {
			sourceInfos.set(skill.filePath, skill.sourceInfo);
		}
	}
	for (const prompt of promptsResult.prompts) {
		if (prompt.sourceInfo) {
			sourceInfos.set(prompt.filePath, prompt.sourceInfo);
		}
	}
	for (const loadedTheme of themesResult.themes) {
		if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
			sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
		}
	}

	if (showListing) {
		const rows: LoadedRowSpec[] = [];
		const systemPromptSource = host.session.resourceLoader.getSystemPromptSource();
		const contextFiles = [
			...(systemPromptSource ? [systemPromptSource] : []),
			...host.session.resourceLoader.getAppendSystemPromptSources(),
			...host.session.resourceLoader.getAgentsFiles().agentsFiles,
		];
		if (contextFiles.length > 0) {
			rows.push({
				label: "Context",
				count: () => contextFiles.length,
				summary: () =>
					formatCompactList(
						contextFiles.map((contextFile) => host.formatContextPath(contextFile.path)),
						{ sort: false },
					),
				expandedSummary: () => theme.fg("dim", "files in the system prompt"),
				details: () =>
					contextFiles
						.map((f) => theme.fg("dim", `  ${sanitizeTerminalText(host.formatDisplayPath(f.path))}`))
						.join("\n"),
			});
		}

		const skills = skillsResult.skills;
		if (skills.length > 0) {
			const groups = host.buildScopeGroups(
				skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
			);
			// Names are rarely news and fill the screen at startup: collapsed shows the count, ctrl+o the list.
			rows.push({
				label: "Skills",
				count: () => skills.length,
				summary: listHint,
				expandedSummary: () => theme.fg("dim", "loaded on demand"),
				details: () =>
					host.formatScopeGroups(groups, {
						formatPath: (item) => host.formatDisplayPath(item.path),
						formatPackagePath: (item) => host.getShortPath(item.path, item.sourceInfo),
					}),
			});
		}

		const events = host.session.resourceLoader.getEventBus?.();
		if (events) {
			// Servers start after the listing: this row follows their status and repaints alone.
			const mcp = mcpStatusSource(events);
			rows.push({
				label: "MCP",
				count: () => mcp.getState().length,
				source: mcp,
				summary: () => mcp.getState().map(mcpSummary).join(theme.fg("dim", SEPARATOR)),
				expandedSummary: () => {
					const connected = mcp.getState().filter((server) => server.enabled && server.state === "connected").length;
					return theme.fg("dim", `${connected} connected`);
				},
				details: () =>
					mcp
						.getState()
						.map(
							(server) =>
								`  ${mcpSummary(server)}${theme.fg("dim", sanitizeTerminalText(`${SEPARATOR}${server.exposure}${SEPARATOR}${server.source}`))}`,
						)
						.join("\n"),
			});
		}

		const templates = host.session.promptTemplates;
		if (templates.length > 0) {
			const groups = host.buildScopeGroups(
				templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
			);
			const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
			const templateList = () =>
				host.formatScopeGroups(groups, {
					formatPath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : host.formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : host.formatDisplayPath(item.path);
					},
				});
			rows.push({
				label: "Prompts",
				count: () => templates.length,
				summary: () => formatCompactList(templates.map((template) => `/${template.name}`)),
				expandedSummary: () => "",
				details: templateList,
			});
		}

		if (extensions.length > 0) {
			const groups = host.buildScopeGroups(extensions);
			const extList = () =>
				host.formatScopeGroups(groups, {
					formatPath: (item) => host.formatExtensionDisplayPath(item.path),
					formatPackagePath: (item) => host.formatExtensionDisplayPath(host.getShortPath(item.path, item.sourceInfo)),
				});
			const extensionLabels = host.getCompactExtensionLabels(extensions);
			rows.push({
				label: "Extensions",
				count: () => extensions.length,
				summary: () => formatCompactList(extensionLabels),
				expandedSummary: () => "",
				details: extList,
			});
		}

		if (rows.length > 0) {
			const columns = () => loadedColumns(rows);
			const requestRender = () => host.ui.requestRender();
			for (const row of rows) {
				host.loadedResourcesContainer.addChild(
					new LoadedRow(row, columns, host.getStartupExpansionState(), requestRender),
				);
			}
		}
	}

	/** Adds a block, one blank line after the previous one; the transcript and the editor open with their own gap. */
	const addBlock = (block: Component) => {
		if (host.loadedResourcesContainer.children.length > 0) host.loadedResourcesContainer.addChild(new Spacer(1));
		host.loadedResourcesContainer.addChild(block);
	};

	if (showDiagnostics) {
		// Name collisions are routine when the same skills are installed in two places: collapsed, they are one
		// line; other diagnostics stay listed because they need action. Expanding shows every path.
		const addDiagnostics = (title: string, kind: string, diagnostics: ResourceDiagnostic[]) => {
			if (diagnostics.length === 0) return;
			const collisions = new Set(
				diagnostics.flatMap((d) => (d.type === "collision" && d.collision ? [d.collision.name] : [])),
			);
			const others = diagnostics.filter((d) => !(d.type === "collision" && d.collision));
			// One short line stands for the routine duplicates; anything else stays listed.
			const duplicates = `${collisions.size} ${kind}${collisions.size === 1 ? " has" : "s have"} duplicates; first found is used`;
			const compact = () =>
				[
					theme.fg("warning", title),
					...(collisions.size > 0 ? [theme.fg("dim", `  ${duplicates}`)] : []),
					...(others.length > 0 ? [host.formatDiagnostics(others, sourceInfos)] : []),
				].join("\n");
			const full = () => `${theme.fg("warning", title)}\n${host.formatDiagnostics(diagnostics, sourceInfos)}`;
			const section = new ExpandableText(compact, full, host.getStartupExpansionState(), 0, 0);
			section.setHangingIndent(true);
			addBlock(section);
		};
		addDiagnostics(warningTitle("Skill conflicts"), "skill", skillsResult.diagnostics);
		addDiagnostics(warningTitle("Prompt conflicts"), "prompt", promptsResult.diagnostics);

		const extensionDiagnostics: ResourceDiagnostic[] = [];
		const extensionsResult = host.session.resourceLoader.getExtensions();
		for (const error of extensionsResult.errors) {
			extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
		}
		for (const warning of extensionsResult.warnings ?? []) {
			extensionDiagnostics.push({ type: "warning", message: warning.warning, path: warning.path });
		}

		const commandDiagnostics = host.session.extensionRunner.getCommandDiagnostics();
		extensionDiagnostics.push(...commandDiagnostics);
		extensionDiagnostics.push(...host.getBuiltInCommandConflictDiagnostics(host.session.extensionRunner));

		const shortcutDiagnostics = host.session.extensionRunner.getShortcutDiagnostics();
		extensionDiagnostics.push(...shortcutDiagnostics);

		if (extensionDiagnostics.length > 0) {
			const warningLines = () => host.formatDiagnostics(extensionDiagnostics, sourceInfos);
			const issues = new ThemedText(
				() => `${theme.fg("warning", warningTitle("Extension issues"))}\n${warningLines()}`,
				0,
				0,
			);
			issues.setHangingIndent(true);
			addBlock(issues);
		}

		const themeDiagnostics = themesResult.diagnostics;
		if (themeDiagnostics.length > 0) {
			const warningLines = () => host.formatDiagnostics(themeDiagnostics, sourceInfos);
			const conflicts = new ThemedText(
				() => `${theme.fg("warning", warningTitle("Theme conflicts"))}\n${warningLines()}`,
				0,
				0,
			);
			conflicts.setHangingIndent(true);
			addBlock(conflicts);
		}
	}
}

/** Diagnostic headings share the warning mark with the rest of the TUI. */
const warningTitle = (name: string) => `${GLYPH.warning} ${name}`;

type McpStatus = ReturnType<typeof getMcpSessionStatus>[number];

/** The session's MCP statuses as a state source: the snapshot is refreshed once per published change. */
function mcpStatusSource(events: EventBus): StateSource<readonly McpStatus[]> {
	let servers = getMcpSessionStatus(events);
	return {
		getState: () => servers,
		subscribe: (listener) =>
			events.on(MCP_STATUS_EVENT, () => {
				servers = getMcpSessionStatus(events);
				listener();
			}),
	};
}

/** Server states as the design language's states; a connected server shows the presence mark instead. */
const MCP_STATE: Readonly<Record<string, UiState>> = {
	starting: "pending",
	connecting: "pending",
	"needs-auth": "waiting",
	failed: "failed",
	disconnected: "failed",
	stopped: "stopped",
	closed: "stopped",
};

/** Wording as `/mcp` uses it (`describeState`). */
const MCP_LABEL: Readonly<Record<string, string>> = {
	unselected: "not selected",
	starting: `starting${ELLIPSIS}`,
	connecting: `connecting${ELLIPSIS}`,
	"needs-auth": "needs sign-in",
};

/** `● name state`: the shared mark and colour for the server's state, then a connected server's tool count. */
function mcpSummary(server: McpStatus): string {
	const state = server.enabled ? server.state : "disabled";
	const ui = MCP_STATE[state] ?? "pending";
	const mark = state === "connected" ? theme.fg(STATE_COLOR.done, GLYPH.live) : theme.fg(STATE_COLOR[ui], GLYPH[ui]);
	const label =
		state === "connected" && server.toolCount > 0
			? `connected (${server.toolCount} tool${server.toolCount === 1 ? "" : "s"})`
			: (MCP_LABEL[state] ?? state);
	return `${mark} ${theme.fg("muted", sanitizeTerminalText(server.name))} ${theme.fg("dim", sanitizeTerminalText(label))}`;
}
