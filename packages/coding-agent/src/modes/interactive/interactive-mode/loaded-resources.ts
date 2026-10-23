/**
 * The startup listing of loaded context files, skills, MCP servers, prompts and extensions, followed by resource
 * diagnostics.
 */

import { Spacer } from "@octocodeai/octocode-tui";
import { getMcpSessionStatus } from "../../../extensions/mcp/status.ts";
import { sanitizeTerminalText } from "../../../octocode/shared/sanitize.ts";
import type { ResourceDiagnostic } from "../../../core/resource-loader.ts";
import type { SourceInfo } from "../../../core/source-info.ts";
import { keyText } from "../components/keybinding-hints.ts";
import { ThemedText } from "../components/themed-text.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { ExpandableText } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the loaded-resources listing. */
export type LoadedResourcesHost = Pick<
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
>;

export function showLoadedResources(
	host: LoadedResourcesHost,
	options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	},
): void {
	// Resource rendering is idempotent; chat clears no longer clear this separate container.
	host.loadedResourcesContainer.clear();

	const showListing = options?.force || host.shouldShowStartupDetails();
	const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
	if (!showListing && !showDiagnostics) {
		return;
	}

	const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
	const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
		const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
		if (options?.sort !== false) {
			labels.sort((a, b) => a.localeCompare(b));
		}
		return theme.fg("dim", `  ${labels.join(", ")}`);
	};
	// Bodies are built on demand so the listing follows theme changes.
	const addLoadedSection = (
		name: string,
		collapsedBody: () => string,
		expandedBody = collapsedBody,
		color: ThemeColor = "mdHeading",
	): void => {
		const section = new ExpandableText(
			() => `${sectionHeader(name, color)}\n${collapsedBody()}`,
			() => `${sectionHeader(name, color)}\n${expandedBody()}`,
			host.getStartupExpansionState(),
			0,
			0,
		);
		section.setHangingIndent(true);
		host.loadedResourcesContainer.addChild(section);
		host.loadedResourcesContainer.addChild(new Spacer(1));
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
		const systemPromptSource = host.session.resourceLoader.getSystemPromptSource();
		const contextFiles = [
			...(systemPromptSource ? [systemPromptSource] : []),
			...host.session.resourceLoader.getAppendSystemPromptSources(),
			...host.session.resourceLoader.getAgentsFiles().agentsFiles,
		];
		if (contextFiles.length > 0) {
			host.loadedResourcesContainer.addChild(new Spacer(1));
			const contextList = () =>
				contextFiles.map((f) => theme.fg("dim", `  ${host.formatDisplayPath(f.path)}`)).join("\n");
			const contextCompactList = () =>
				formatCompactList(
					contextFiles.map((contextFile) => host.formatContextPath(contextFile.path)),
					{ sort: false },
				);
			addLoadedSection("Context", contextCompactList, contextList);
		}

		const skills = skillsResult.skills;
		if (skills.length > 0) {
			const groups = host.buildScopeGroups(
				skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
			);
			const skillList = () =>
				host.formatScopeGroups(groups, {
					formatPath: (item) => host.formatDisplayPath(item.path),
					formatPackagePath: (item) => host.getShortPath(item.path, item.sourceInfo),
				});
			const skillCompactList = () => formatCompactList(skills.map((skill) => skill.name));
			addLoadedSection("Skills", skillCompactList, skillList);
		}

		const events = host.session.resourceLoader.getEventBus?.();
		const servers = events ? getMcpSessionStatus(events) : [];
		if (servers.length > 0) {
			const summary = (server: (typeof servers)[number]) =>
				sanitizeTerminalText(`${server.name}: ${server.enabled ? server.state : "disabled"}`);
			addLoadedSection(
				"MCPs",
				() => formatCompactList(servers.map(summary)),
				() =>
					servers
						.map((server) =>
							theme.fg(
								"dim",
								sanitizeTerminalText(
									`  ${summary(server)} · ${server.exposure} · ${server.toolCount} tools · ${server.source}`,
								),
							),
						)
						.join("\n"),
			);
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
			const promptCompactList = () => formatCompactList(templates.map((template) => `/${template.name}`));
			addLoadedSection("Prompts", promptCompactList, templateList);
		}

		if (extensions.length > 0) {
			const groups = host.buildScopeGroups(extensions);
			const extList = () =>
				host.formatScopeGroups(groups, {
					formatPath: (item) => host.formatExtensionDisplayPath(item.path),
					formatPackagePath: (item) => host.formatExtensionDisplayPath(host.getShortPath(item.path, item.sourceInfo)),
				});
			const extensionLabels = host.getCompactExtensionLabels(extensions);
			const extensionCompactList = () => formatCompactList(extensionLabels);
			addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
		}
	}

	if (showDiagnostics) {
		// Name collisions are routine when the same skills are installed in two places: collapsed, they are one
		// line; other diagnostics stay listed because they need action. Expanding shows every path.
		const addDiagnostics = (title: string, kind: string, diagnostics: ResourceDiagnostic[]) => {
			if (diagnostics.length === 0) return;
			const collisions = new Set(
				diagnostics.flatMap((d) => (d.type === "collision" && d.collision ? [d.collision.name] : [])),
			);
			const others = diagnostics.filter((d) => !(d.type === "collision" && d.collision));
			const full = () => `${theme.fg("warning", title)}\n${host.formatDiagnostics(diagnostics, sourceInfos)}`;
			const compact = () =>
				[
					theme.fg("warning", title),
					...(collisions.size > 0
						? [
								theme.fg(
									"dim",
									`  ${collisions.size} ${kind}${collisions.size === 1 ? " is" : "s are"} defined more than once; the first found is used (${keyText("app.tools.expand")} for paths)`,
								),
							]
						: []),
					...(others.length > 0 ? [host.formatDiagnostics(others, sourceInfos)] : []),
				].join("\n");
			host.loadedResourcesContainer.addChild(new ExpandableText(compact, full, host.getStartupExpansionState(), 0, 0));
			host.loadedResourcesContainer.addChild(new Spacer(1));
		};
		addDiagnostics("[Skill conflicts]", "skill", skillsResult.diagnostics);
		addDiagnostics("[Prompt conflicts]", "prompt", promptsResult.diagnostics);

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
			host.loadedResourcesContainer.addChild(
				new ThemedText(() => `${theme.fg("warning", "[Extension issues]")}\n${warningLines()}`, 0, 0),
			);
			host.loadedResourcesContainer.addChild(new Spacer(1));
		}

		const themeDiagnostics = themesResult.diagnostics;
		if (themeDiagnostics.length > 0) {
			const warningLines = () => host.formatDiagnostics(themeDiagnostics, sourceInfos);
			host.loadedResourcesContainer.addChild(
				new ThemedText(() => `${theme.fg("warning", "[Theme conflicts]")}\n${warningLines()}`, 0, 0),
			);
			host.loadedResourcesContainer.addChild(new Spacer(1));
		}
	}
}
