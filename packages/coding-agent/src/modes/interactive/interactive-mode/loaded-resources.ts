/**
 * The startup listing of loaded context files, skills, MCP servers, prompts and extensions (one aligned row each, with
 * a count; ctrl+o lists the items), followed by resource diagnostics.
 */

import { type Component, type Container, GLYPH, SEPARATOR, Spacer, ThemedText } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { getAgentDir } from "../../../config.ts";
import { contextFilesBudgetWarning, projectContextOf } from "../../../core/context-budget.ts";
import { collectContextView } from "../../../core/discovery/context-snapshot.ts";
import { type ContextView, type LoadedRef, sourceInfoLabel } from "../../../core/discovery/context-view.ts";
import { takePiNotice } from "../../../core/discovery/pi-notice.ts";
import { keybindingProblems } from "../../../core/keybindings.ts";
import type { ResourceDiagnostic } from "../../../core/resource-loader.ts";
import { warningsBesideListing } from "../../../core/resource-loader/feature-loading.ts";
import type { Skill } from "../../../core/skills.ts";
import {
	skillListingBudgetWarning,
	skillListingOf,
	skillListingBudgetChars,
} from "../../../core/skills/listing-budget.ts";
import type { SourceInfo } from "../../../core/source-info.ts";
import { legend } from "../../../theme/page-kit.ts";
import { theme } from "../../../theme/theme.ts";
import { ExpandableText } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import { harnessRow, startupWarnings, viewRows } from "./discovery-rows.ts";
import { sessionHarnesses } from "../../../core/discovery/vendors/prompt.ts";
import { mcpRow } from "./loaded-mcp.ts";
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
	let view: ContextView | undefined;
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
		// Collapsed, the listing shows what the agent includes now; agents, prompts, themes and code that does not run are
		// listed only expanded.
		view = loadedContextView(host, skillsResult.skills);
		const budget = skillListingBudgetChars(host.session.model?.contextWindow);
		const prompt = host.session.systemPrompt ?? "";
		const viewSpecs = viewRows(view, (path) => host.formatDisplayPath(path), {
			context: { chars: projectContextOf(prompt)?.length ?? 0, budget },
			skill: { chars: skillListingOf(prompt)?.length ?? 0, budget },
		});
		const viewRow = (id: string) => viewSpecs.filter((row) => row.id === id).map((row) => row.spec);
		const rows: LoadedRowSpec[] = [...viewRow("context"), ...viewRow("skill")];
		piNotice = takePiNotice(view, getAgentDir());

		const events = host.session.resourceLoader.getEventBus?.();
		if (events) {
			rows.push(mcpRow(events));
		}

		rows.push(...viewRow("hook"), ...viewRow("plugin"));
		const models = host.session.modelRuntime?.getAvailableSnapshot() ?? [];
		rows.push({
			label: "Model",
			count: () => 1,
			state: () => (host.session.model ? "ready" : "attention"),
			summary: () =>
				`${sanitizeTerminalText(host.session.model?.id ?? "none selected")} · ${new Set(models.map((m) => m.provider)).size} providers · ${models.length} models · /model · /providers`,
			details: () => models.map((m) => `  ${m.provider}/${m.id}`).join("\n"),
		});
		rows.push(...viewRow("keybinding").map((spec) => withCommand({ ...spec, label: "Keys" }, "/keys")));
		rows.push(...viewRow("setting").map((spec) => withCommand(spec, "/settings")));
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
				summary: () => `${formatCompactList(extensionLabels)} · /harness`,
				expandedSummary: () => "/harness",
				details: extList,
			});
		}
		// The Harness line closes what the agent includes now; the expanded-only rows follow it.
		rows.push(harnessRow(sessionHarnesses({ cwd: host.sessionManager.getCwd(), settings: host.settingsManager })));
		for (const id of ["agent", "prompt", "theme"])
			rows.push(...viewRow(id).map((spec) => ({ ...spec, expandedOnly: true })));
		// Code Octocode does not run (`pi` extensions and hooks) is listed, with the way to move it to a supported place.
		rows.push(...viewRow("extension").map((spec) => ({ ...spec, expandedOnly: true })));

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
				host.loadedResourcesContainer.addChild({
					invalidate() {},
					render: (width) =>
						new ThemedText(
							() =>
								theme.fg(
									"dim",
									`${legend(rows.filter((r) => (r.count() > 0 || r.showZero) && (!r.expandedOnly || host.getStartupExpansionState())).map((r) => r.state?.() ?? "ready"))} · ${expandHint()}`,
								),
							0,
							0,
						).render(width),
				});
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
		// One line per warning (what is wrong, what to do); expanded, each lists its items and the notes follow.
		const addWarningLines = ({ warnings, notes }: ReturnType<typeof startupWarnings>) => {
			if (warnings.length === 0 && notes.length === 0) return;
			const text = (line: string) => sanitizeTerminalText(line);
			const compact = () => warnings.map((w) => theme.fg("warning", warningTitle(text(w.text)))).join("\n");
			const full = () =>
				[
					...warnings.flatMap((w) => [
						theme.fg("warning", warningTitle(text(w.text))),
						...w.details.map((d) => theme.fg("dim", `    ${text(d)}`)),
					]),
					...notes.flatMap((n) => [
						theme.fg("muted", text(n.text)),
						...n.details.map((d) => theme.fg("dim", `    ${text(d)}`)),
					]),
				].join("\n");
			const section = new ExpandableText(compact, full, host.getStartupExpansionState(), 0, 0);
			section.setHangingIndent(true);
			addBlock(section);
		};
		const startup = startupWarnings(
			view ?? loadedContextView(host, skillsResult.skills),
			skillsResult.diagnostics,
			keybindingProblems(),
		);
		// Measured on the listing the model receives; it is never shortened, so the user is told instead.
		const { systemPrompt, model, resourceLoader } = host.session;
		const contextWindow = model?.contextWindow;
		const listing = skillListingOf(systemPrompt);
		const overBudget = listing
			? skillListingBudgetWarning({ skills: skillsResult.skills, listing, contextWindow })
			: undefined;
		const contextOver = contextFilesBudgetWarning({
			systemPrompt,
			files: resourceLoader.getAgentsFiles().agentsFiles,
			contextWindow,
		});
		addWarningLines({
			...startup,
			warnings: [
				...startup.warnings,
				...(!showListing && overBudget ? [{ text: overBudget.message, details: [] }] : []),
				...(!showListing && contextOver ? [contextOver] : []),
			],
		});
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

/** Appends the command that changes a row's files (`· /settings`) to its collapsed text. */
function withCommand(spec: LoadedRowSpec, command: string): LoadedRowSpec {
	const hint = theme.fg("dim", `${SEPARATOR}${command}`);
	const cells = spec.cells;
	return {
		...spec,
		summary: () => spec.summary() + hint,
		...(cells ? { cells: () => ({ ...cells(), sources: cells().sources + hint }) } : {}),
	};
}

/** Diagnostic headings share the warning mark with the rest of the TUI. */
const warningTitle = (name: string) => `${GLYPH.warning} ${name}`;
