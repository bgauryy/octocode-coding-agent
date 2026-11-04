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
import { getAgentDir, getLegacyConfigDirs } from "../../../config.ts";
import { collectContextView } from "../../../core/discovery/context-snapshot.ts";
import {
	type ContextView,
	type LoadedRef,
	buildContextView,
	sourceInfoLabel,
	sourceSummary,
} from "../../../core/discovery/context-view.ts";
import { takePiNotice } from "../../../core/discovery/pi-notice.ts";
import type { ResourceDiagnostic } from "../../../core/resource-loader.ts";
import { warningsBesideListing } from "../../../core/resource-loader/feature-loading.ts";
import type { Skill } from "../../../core/skills.ts";
import type { SourceInfo } from "../../../core/source-info.ts";
import { ThemedText } from "../components/themed-text.ts";
import { STATE_COLOR } from "../../../theme/status.ts";
import { theme } from "../../../theme/theme.ts";
import { ExpandableText } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import { viewRows } from "./discovery-rows.ts";
import { LoadedRow, type LoadedRowSpec, expandHint, loadedColumns } from "./loaded-row.ts";
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
	| "sessionManager"
	| "settingsManager"
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

	let piNotice: string | undefined;
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
		// Context, skills, prompts and the other file-based kinds come from the loaded-context view (one row per kind, with
		// where each item came from); MCP follows live server status, and loaded extension code keeps its own labels.
		const view = loadedContextView(host, skillsResult.skills);
		const viewSpecs = viewRows(view, (path) => host.formatDisplayPath(path));
		const viewRow = (id: string) => viewSpecs.filter((row) => row.id === id).map((row) => row.spec);
		const rows: LoadedRowSpec[] = [
			...viewRow("context"),
			...viewRow("skill"),
			...viewRow("agent"),
			...viewRow("model"),
		];
		piNotice = takePiNotice(view, getAgentDir());

		const events = host.session.resourceLoader.getEventBus?.();
		if (events) {
			// Servers start after the listing: this row follows their status and repaints alone.
			const mcp = mcpStatusSource(events);
			rows.push({
				label: "MCP",
				count: () => mcp.getState().length,
				source: mcp,
				summary: () => mcp.getState().map(mcpListed).join(theme.fg("dim", SEPARATOR)),
				cells: () => ({
					sources: mcp.getState().map(mcpListed).join(theme.fg("dim", SEPARATOR)),
					tail: theme.fg("dim", sanitizeTerminalText(mcpSources(mcp.getState()))),
				}),
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

		for (const id of ["hook", "plugin", "prompt", "theme", "keybinding", "setting"]) rows.push(...viewRow(id));

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
		// Code Octocode does not run (`pi` extensions and hooks) is listed, with the way to move it to a supported place.
		rows.push(...viewRow("extension"), ...viewRow("warning"));

		if (rows.length > 0) {
			const columns = () => loadedColumns(rows);
			const requestRender = () => host.ui.requestRender();
			for (const row of rows) {
				host.loadedResourcesContainer.addChild(
					new LoadedRow(row, columns, host.getStartupExpansionState(), requestRender),
				);
			}
			// Rows with a list behind them are collapsed: say how to open them, and drop the hint once they are open.
			if (rows.some((row) => row.details && row.count() > 0))
				host.loadedResourcesContainer.addChild(
					new ExpandableText(expandHint, () => "", host.getStartupExpansionState(), 0, 0),
				);
		}
	}

	/** Adds a block, one blank line after the previous one; the transcript and the editor open with their own gap. */
	const addBlock = (block: Component) => {
		if (host.loadedResourcesContainer.children.length > 0) host.loadedResourcesContainer.addChild(new Spacer(1));
		host.loadedResourcesContainer.addChild(block);
	};

	if (piNotice) addBlock(new ThemedText(() => theme.fg("muted", sanitizeTerminalText(piNotice ?? "")), 0, 0));

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
		// Code that is not loaded has its row in the listing above; the other loader warnings need this block.
		for (const warning of showListing
			? warningsBesideListing(extensionsResult.warnings)
			: (extensionsResult.warnings ?? [])) {
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

/** The loaded-context view: discovery joined with what this session's loaders loaded. */
function loadedContextView(host: LoadedResourcesHost, skills: readonly Skill[]): ContextView {
	const loader = host.session.resourceLoader;
	const ref = (path: string, sourceInfo?: SourceInfo, name?: string): LoadedRef => ({
		path,
		...(name ? { name } : {}),
		label: sourceInfoLabel(sourceInfo),
	});
	const agentDir = getAgentDir();
	const systemPrompt = loader.getSystemPromptSource();
	return collectContextView({
		cwd: host.sessionManager.getCwd(),
		agentDir,
		projectTrusted: host.settingsManager.isProjectTrusted(),
		settings: host.settingsManager.getSettings(),
		loaded: {
			// Project instruction files come from the loader: discovery lists only the global one.
			context: loader.getAgentsFiles().agentsFiles.map((file) => ({ path: file.path, label: "project" })),
			systemPrompt: systemPrompt ? [{ path: systemPrompt.path, label: "path" }] : [],
			appendSystemPrompt: loader.getAppendSystemPromptSources().map((source) => ({ path: source.path, label: "path" })),
			skill: skills.map((skill) => ref(skill.filePath, skill.sourceInfo, skill.name)),
			prompt: host.session.promptTemplates.map((template) =>
				ref(template.filePath, template.sourceInfo, template.name),
			),
		},
	});
}

/** `builtin 1 · octocode global 2 · pi project 1`: where the MCP servers are defined (their names are in the row). */
function mcpSources(servers: readonly McpStatus[]): string {
	const view = buildContextView({ discovery: new Map(), mcp: servers, piRoots: getLegacyConfigDirs(getAgentDir()) });
	return view.groups.map((group) => sourceSummary(group, { counted: true })).join(SEPARATOR);
}

/** Diagnostic headings share the warning mark with the rest of the TUI. */
const warningTitle = (name: string) => `${GLYPH.warning} ${name}`;

type McpStatus = ReturnType<typeof getMcpSessionStatus>[number];

/** A server that failed or dropped is news and stays in the collapsed row; connecting and connected are routine. */
const mcpFailed = (server: McpStatus): boolean =>
	server.enabled && (server.state === "failed" || server.state === "disconnected");

/** What the collapsed row draws: which servers exist, which apply and which failed, never routine connection state. */
const mcpListing = (servers: readonly McpStatus[]): string =>
	servers
		.map((server) => `${server.name}:${server.enabled}:${server.state === "unselected"}:${mcpFailed(server)}`)
		.join("\n");

/**
 * The session's MCP statuses as a state source. `getState` is live, so ctrl+o details show current states, but only a
 * change to the listing (a server appearing, or a selection) repaints the row: a connection state that moves on after
 * the row scrolled above the viewport would make the renderer clear and redraw the whole scrollback, banner included.
 */
function mcpStatusSource(events: EventBus): StateSource<readonly McpStatus[]> {
	return {
		getState: () => getMcpSessionStatus(events),
		subscribe: (listener) => {
			let listed = mcpListing(getMcpSessionStatus(events));
			return events.on(MCP_STATUS_EVENT, (servers) => {
				const next = mcpListing(servers as readonly McpStatus[]);
				if (next === listed) return;
				listed = next;
				listener();
			});
		},
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

/** The collapsed row's entry: `name`, or `○ name disabled` / `✗ name failed` for a server that does not apply or failed. Connection state is in the details. */
function mcpListed(server: McpStatus): string {
	if (server.enabled && server.state !== "unselected" && !mcpFailed(server))
		return theme.fg("muted", sanitizeTerminalText(server.name));
	return mcpSummary(server);
}

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
