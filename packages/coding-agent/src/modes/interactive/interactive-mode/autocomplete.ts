/**
 * Slash-command autocomplete: built-in, prompt-template, extension and skill commands with their argument completions,
 * and the provider chain extensions can wrap.
 */

import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type SlashCommand,
	CombinedAutocompleteProvider,
} from "@octocodeai/octocode-tui";
import type { ExtensionRunner } from "../../../core/features/index.ts";
import type { ResourceDiagnostic } from "../../../core/resource-loader.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../../core/slash-commands.ts";
import { getSkillCommands } from "../../../core/skill-commands.ts";
import { getPromptCommands } from "../../../core/prompt-templates.ts";
import type { SourceInfo } from "../../../core/source-info.ts";
import { parseGitUrl } from "../../../utils/git.ts";
import { getModelSearchText } from "../model-search.ts";
import {
	createFuzzyAutocompleteItems,
	getLoginProviderCompletionOptions,
	getLoginProviderSearchText,
	formatLoginProviderCompletionDescription,
} from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the slash-command autocomplete. */
type AutocompleteHost = Pick<
	InteractiveModeHost,
	| "autocompleteProvider"
	| "autocompleteProviderWrappers"
	| "createBaseAutocompleteProvider"
	| "defaultEditor"
	| "editor"
	| "fdPath"
	| "getLoginProviderOptions"
	| "getSlashCommands"
	| "session"
	| "sessionManager"
	| "settingsManager"
	| "skillCommands"
>;

function getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
	// Built-in extension commands are untagged, like built-in commands.
	if (!sourceInfo || sourceInfo.source === "builtin") {
		return undefined;
	}

	const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
	const source = sourceInfo.source.trim();

	if (source === "auto" || source === "local" || source === "cli") {
		return scopePrefix;
	}

	if (source.startsWith("npm:")) {
		return `${scopePrefix}:${source}`;
	}

	const gitSource = parseGitUrl(source);
	if (gitSource) {
		const ref = gitSource.ref ? `@${gitSource.ref}` : "";
		return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
	}

	return scopePrefix;
}

function prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
	const sourceTag = getAutocompleteSourceTag(sourceInfo);
	if (!sourceTag) {
		return description;
	}
	return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
}

export function getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
	const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
	return extensionRunner
		.getRegisteredCommands()
		.filter((command) => builtinNames.has(command.name) && command.sourceInfo.owner !== "native")
		.map((command) => ({
			type: "warning" as const,
			message:
				command.invocationName === command.name
					? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
					: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
			path: command.sourceInfo.path,
		}));
}

export function getSlashCommands(
	host: AutocompleteHost,
	includeSkills = host.settingsManager.getEnableSkillCommands(),
): SlashCommand[] {
	// Define commands for autocomplete
	const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
		name: command.name,
		description: command.description,
		...(command.argumentHint && { argumentHint: command.argumentHint }),
		...(command.argumentKind && { argumentKind: command.argumentKind }),
		...(command.argumentValues && {
			getArgumentCompletions: (prefix: string) =>
				command.argumentValues!.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		}),
	}));

	const modelCommand = slashCommands.find((command) => command.name === "model");
	if (modelCommand) {
		modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
			const models =
				host.session.scopedModels.length > 0
					? host.session.scopedModels.map((s) => s.model)
					: host.session.modelRuntime.getAvailableSnapshot();

			if (models.length === 0) return null;

			// Create items with provider/id format
			const items = models.map((m) => ({
				id: m.id,
				provider: m.provider,
				name: m.name,
				label: `${m.provider}/${m.id}`,
			}));

			return createFuzzyAutocompleteItems(items, prefix, getModelSearchText, (item) => ({
				value: item.label,
				label: item.id,
				description: item.provider,
			}));
		};
	}

	const thinkingCommand = slashCommands.find((command) => command.name === "effort");
	if (thinkingCommand) {
		thinkingCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
			return createFuzzyAutocompleteItems(
				host.session.getAvailableThinkingLevels(),
				prefix,
				(level) => level,
				(level) => ({
					value: level,
					label: level,
				}),
			);
		};
	}

	const loginCommand = slashCommands.find((command) => command.name === "login");
	if (loginCommand) {
		loginCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
			const providers = getLoginProviderCompletionOptions(host.getLoginProviderOptions()).map((provider) => ({
				value: provider.id,
				label: provider.id,
				description: formatLoginProviderCompletionDescription(provider),
				searchText: getLoginProviderSearchText(provider),
			}));
			providers.push({
				value: "pi",
				label: "pi",
				description: "Pi (config) · import credentials and use configured models",
				searchText: "pi config import credentials models",
			});
			return createFuzzyAutocompleteItems(
				providers,
				prefix,
				(provider) => provider.searchText,
				({ value, label, description }) => ({ value, label, description }),
			);
		};
	}

	for (const name of ["resume", "agents", "permissions", "plan"]) {
		const command = slashCommands.find((command) => command.name === name);
		if (command)
			command.getArgumentCompletions = host.session.extensionRunner
				.getRegisteredCommands()
				.find((entry) => entry.name === name)?.getArgumentCompletions;
	}

	// Convert prompt templates to SlashCommand format for autocomplete
	const templateCommands: SlashCommand[] = getPromptCommands(
		host.session.promptTemplates,
		host.session.extensionRunner.getRegisteredCommands(),
	).map(({ name, template }) => ({
		name,
		description: prefixAutocompleteDescription(template.description, template.sourceInfo),
		...(template.argumentHint && { argumentHint: template.argumentHint }),
	}));

	// Convert extension commands to SlashCommand format
	const builtinCommandNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
	const extensionCommands: SlashCommand[] = host.session.extensionRunner
		.getRegisteredCommands()
		.filter((cmd) => !builtinCommandNames.has(cmd.invocationName))
		.map((cmd) => ({
			name: cmd.invocationName,
			description: prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

	host.skillCommands.clear();
	const skillCommandList: SlashCommand[] = [];
	if (includeSkills) {
		for (const { name, skill } of getSkillCommands(host.session.resourceLoader.getSkills().skills, [
			...host.session.extensionRunner.getRegisteredCommands(),
			...host.session.promptTemplates,
		])) {
			host.skillCommands.set(name, skill.filePath);
			skillCommandList.push({
				name,
				skill: true,
				description: prefixAutocompleteDescription(skill.description, skill.sourceInfo),
			});
		}
	}
	const allCommands = [...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList];
	const helpCommand = slashCommands.find((command) => command.name === "help");
	if (helpCommand)
		helpCommand.getArgumentCompletions = (prefix) =>
			createFuzzyAutocompleteItems(
				allCommands,
				prefix,
				(command) => command.name,
				(command) => ({ value: command.name, label: command.name, description: command.description }),
			);
	return allCommands;
}

export function createBaseAutocompleteProvider(host: AutocompleteHost): AutocompleteProvider {
	return new CombinedAutocompleteProvider(host.getSlashCommands(), host.sessionManager.getCwd(), host.fdPath);
}

export function setupAutocompleteProvider(host: AutocompleteHost): void {
	let provider = host.createBaseAutocompleteProvider();
	const triggerCharacters: string[] = [];
	for (const wrapProvider of host.autocompleteProviderWrappers) {
		provider = wrapProvider(provider);
		triggerCharacters.push(...(provider.triggerCharacters ?? []));
	}
	if (triggerCharacters.length > 0) {
		provider.triggerCharacters = [...new Set(triggerCharacters)];
	}

	host.autocompleteProvider = provider;
	host.defaultEditor.setAutocompleteProvider(provider);
	if (host.editor !== host.defaultEditor) {
		host.editor.setAutocompleteProvider?.(provider);
	}
}
