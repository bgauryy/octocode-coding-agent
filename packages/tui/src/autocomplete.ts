import { basename } from "path";
import { walkDirectoryWithFd } from "./autocomplete/fd.ts";
import {
	getFileSuggestions,
	resolveScopedFuzzyQuery,
	scopedPathForDisplay,
	scoreEntry,
} from "./autocomplete/file-suggestions.ts";
import {
	buildCompletionValue,
	extractQuotedPrefix,
	findLastDelimiter,
	parsePathPrefix,
	stripLeadingWrappers,
	toDisplayPath,
	tokenStartRegex,
} from "./autocomplete/path-prefix.ts";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
	SlashCommand,
} from "./autocomplete/types.ts";
import { fuzzyFilter } from "./fuzzy.ts";

// Combined provider that handles both slash commands and file paths
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	private commands: (SlashCommand | AutocompleteItem)[];
	private basePath: string;
	private fdPath: string | null;

	constructor(commands: (SlashCommand | AutocompleteItem)[] = [], basePath: string, fdPath: string | null = null) {
		this.commands = commands;
		this.basePath = basePath;
		this.fdPath = fdPath;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const atPrefix = this.extractAtPrefix(textBeforeCursor);
		if (atPrefix) {
			const { rawPrefix, isQuotedPrefix } = parsePathPrefix(atPrefix);
			const suggestions = await this.getFuzzyFileSuggestions(rawPrefix, {
				isQuotedPrefix,
				signal: options.signal,
			});
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: atPrefix,
			};
		}

		const commandText = textBeforeCursor.trimStart();
		if (!options.force && commandText.startsWith("/")) {
			const spaceIndex = commandText.search(/\s/);

			if (spaceIndex === -1) {
				const prefix = commandText.slice(1);
				const commandItems = this.commands.map((cmd) => {
					const name = "name" in cmd ? cmd.name : cmd.value;
					const hint = "argumentHint" in cmd && cmd.argumentHint ? cmd.argumentHint : undefined;
					const desc = cmd.description ?? "";
					const detail = hint ? (desc ? `${hint} — ${desc}` : hint) : desc;
					return { name, label: name, description: detail || undefined };
				});

				const bareNameMatches = fuzzyFilter(commandItems, prefix, (item) =>
					item.name.startsWith("skill:") ? item.name.slice("skill:".length) : item.name,
				);
				const bareNameMatchSet = new Set(bareNameMatches);
				const fullNameOnlyMatches = fuzzyFilter(
					commandItems.filter((item) => item.name.startsWith("skill:") && !bareNameMatchSet.has(item)),
					prefix,
					(item) => item.name,
				);
				const filtered = [...bareNameMatches, ...fullNameOnlyMatches].map((item) => ({
					value: item.name,
					label: item.label,
					...(item.description && { description: item.description }),
				}));

				if (filtered.length === 0) return null;

				return {
					items: filtered,
					prefix: commandText,
				};
			}

			const commandName = commandText.slice(1, spaceIndex);
			const argumentText = commandText.slice(spaceIndex + 1);

			const command = this.commands.find((cmd) => ("name" in cmd ? cmd.name : cmd.value) === commandName);
			if (command && "argumentKind" in command && command.argumentKind === "path") {
				const items = getFileSuggestions(this.basePath, argumentText);
				return items.length ? { items, prefix: argumentText } : null;
			}
			if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
				return null;
			}

			const argumentSuggestions = await command.getArgumentCompletions(argumentText);
			if (!Array.isArray(argumentSuggestions) || argumentSuggestions.length === 0) {
				return null;
			}

			return {
				items: argumentSuggestions,
				prefix: argumentText,
			};
		}

		const pathMatch = this.extractPathPrefix(textBeforeCursor, options.force ?? false);
		if (pathMatch === null) {
			return null;
		}

		const suggestions = getFileSuggestions(this.basePath, pathMatch);
		if (suggestions.length === 0) return null;

		return {
			items: suggestions,
			prefix: pathMatch,
		};
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] || "";
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		const afterCursor = currentLine.slice(cursorCol);
		const isQuotedPrefix = prefix.startsWith('"') || prefix.startsWith('@"');
		const hasLeadingQuoteAfterCursor = afterCursor.startsWith('"');
		const hasTrailingQuoteInItem = item.value.endsWith('"');
		const adjustedAfterCursor =
			isQuotedPrefix && hasTrailingQuoteInItem && hasLeadingQuoteAfterCursor ? afterCursor.slice(1) : afterCursor;

		const replaceLine = (inserted: string, cursorOffset: number) => {
			const newLines = [...lines];
			newLines[cursorLine] = beforePrefix + inserted + adjustedAfterCursor;
			return { lines: newLines, cursorLine, cursorCol: beforePrefix.length + cursorOffset };
		};

		// Check if we're completing a slash command (prefix starts with "/" but NOT a file path)
		// Slash commands are at the start of the line and don't contain path separators after the first /
		const isSlashCommand = prefix.startsWith("/") && beforePrefix.trim() === "" && !prefix.slice(1).includes("/");
		if (isSlashCommand) {
			return replaceLine(`/${item.value} `, item.value.length + 2); // +2 for "/" and space
		}

		// A directory's closing quote stays after the cursor so the user can continue autocompleting inside it.
		const isDirectory = item.label.endsWith("/");
		const valueOffset = isDirectory && item.value.endsWith('"') ? item.value.length - 1 : item.value.length;

		// File attachments (`@`) get a trailing space after files but not after directories.
		if (prefix.startsWith("@") && !isDirectory) {
			return replaceLine(`${item.value} `, valueOffset + 1);
		}

		// Command arguments, directory attachments and file paths insert the value alone.
		return replaceLine(item.value, valueOffset);
	}

	// Extract @ prefix for fuzzy file suggestions
	private extractAtPrefix(text: string): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix?.startsWith('@"')) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const token = stripLeadingWrappers(lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1));

		if (token.startsWith("@")) {
			return token;
		}

		return null;
	}

	// Extract a path-like prefix from the text before cursor
	private extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const pathPrefix = stripLeadingWrappers(lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1));

		// For forced extraction (Tab key), always return something
		if (forceExtract) {
			return pathPrefix;
		}

		// For natural triggers, return if it looks like a path, ends with /, starts with ~/, .
		// Only return empty string if the text looks like it's starting a path context
		if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
			return pathPrefix;
		}

		// Return an empty prefix after whitespace or CJK punctuation, but not for empty text.
		// Empty text should not trigger file suggestions - that's for forced Tab completion
		if (pathPrefix === "" && text !== "" && tokenStartRegex.test(text)) {
			return pathPrefix;
		}

		return null;
	}

	private async getBaseDirSuggestions(
		baseDir: string,
		query: string,
		signal: AbortSignal,
	): Promise<Array<{ path: string; isDirectory: boolean }>> {
		if (!this.fdPath || signal.aborted) {
			return [];
		}

		return await walkDirectoryWithFd(baseDir, this.fdPath, query, 100, signal, 1);
	}

	// Fuzzy file search using fd (fast, respects .gitignore)
	private async getFuzzyFileSuggestions(
		query: string,
		options: { isQuotedPrefix: boolean; signal: AbortSignal },
	): Promise<AutocompleteItem[]> {
		if (!this.fdPath || options.signal.aborted) {
			return [];
		}

		try {
			const scopedQuery = resolveScopedFuzzyQuery(this.basePath, query);
			const fdBaseDir = scopedQuery?.baseDir ?? this.basePath;
			const fdQuery = scopedQuery?.query ?? query;
			const baseDirEntries = await this.getBaseDirSuggestions(fdBaseDir, fdQuery, options.signal);
			const recursiveEntries = await walkDirectoryWithFd(fdBaseDir, this.fdPath, fdQuery, 100, options.signal);
			const seenPaths = new Set(baseDirEntries.map((entry) => entry.path));
			const entries = [
				...baseDirEntries,
				...recursiveEntries.filter((entry) => {
					if (seenPaths.has(entry.path)) return false;
					seenPaths.add(entry.path);
					return true;
				}),
			];
			if (options.signal.aborted) {
				return [];
			}

			const scoredEntries = entries
				.map((entry) => ({
					...entry,
					score: fdQuery ? scoreEntry(entry.path, fdQuery, entry.isDirectory) : 1,
				}))
				.filter((entry) => entry.score > 0);

			scoredEntries.sort((a, b) => {
				const scoreDiff = b.score - a.score;
				if (scoreDiff !== 0) return scoreDiff;

				const aDepth = toDisplayPath(a.path).split("/").filter(Boolean).length;
				const bDepth = toDisplayPath(b.path).split("/").filter(Boolean).length;
				const depthDiff = aDepth - bDepth;
				if (depthDiff !== 0) return depthDiff;

				const lengthDiff = a.path.length - b.path.length;
				if (lengthDiff !== 0) return lengthDiff;

				return a.path.localeCompare(b.path);
			});
			const topEntries = scoredEntries.slice(0, 20);

			const suggestions: AutocompleteItem[] = [];
			for (const { path: entryPath, isDirectory } of topEntries) {
				const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
				const displayPath = scopedQuery
					? scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash)
					: pathWithoutSlash;
				const entryName = basename(pathWithoutSlash);
				const completionPath = isDirectory ? `${displayPath}/` : displayPath;
				const value = buildCompletionValue(completionPath, {
					isDirectory,
					isAtPrefix: true,
					isQuotedPrefix: options.isQuotedPrefix,
				});

				suggestions.push({
					value,
					label: entryName + (isDirectory ? "/" : ""),
					description: displayPath,
				});
			}

			return suggestions;
		} catch {
			return [];
		}
	}

	// Check if we should trigger file completion (called on Tab key)
	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Don't trigger if we're typing a slash command at the start of the line
		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return false;
		}

		return true;
	}
}
