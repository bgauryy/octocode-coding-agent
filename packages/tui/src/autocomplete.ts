import { basename, isAbsolute, relative } from "node:path";
import { walkDirectoryWithFd } from "./autocomplete/fd.ts";
import { getFileIndex, getFileIndexStatus, refreshFileIndexNow, type IndexedPath } from "./autocomplete/file-index.ts";
import { getFileSuggestions, resolveScopedFuzzyQuery, scopedPathForDisplay } from "./autocomplete/file-suggestions.ts";
import {
	buildCompletionValue,
	extractQuotedPrefix,
	findLastDelimiter,
	parsePathPrefix,
	stripLeadingWrappers,
	toDisplayPath,
	tokenStartRegex,
} from "./autocomplete/path-prefix.ts";
import { basenameMatches, rankPaths, type RankedPath } from "./autocomplete/rank-paths.ts";
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
	/** Entries that matched the previous query: a query that extends it only needs to rank these. */
	private lastRank?: { source: readonly IndexedPath[]; query: string; matched: IndexedPath[] };

	constructor(commands: (SlashCommand | AutocompleteItem)[], basePath: string, fdPath: string | null = null) {
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
		// A command name holds no `/`: `//note` and `/usr/bin` are text (the app sends them as a prompt), not a command.
		if (!options.force && /^\/[^\s/]*(?:\s|$)/.test(commandText)) {
			const spaceIndex = commandText.search(/\s/);

			if (spaceIndex === -1) {
				return this.commandSuggestions(commandText, commandText.slice(1), this.commands);
			}

			const commandName = commandText.slice(1, spaceIndex);
			const argumentText = commandText.slice(spaceIndex + 1);

			const command = this.commands.find((cmd) => ("name" in cmd ? cmd.name : cmd.value) === commandName);
			if (command && "argumentKind" in command && command.argumentKind === "path") {
				const items = await getFileSuggestions(this.basePath, argumentText);
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

		// A `/` at a token start inside the text lists skills only: it names a skill to use, it never runs a command.
		const skillToken = !options.force ? /(?:^|\s)(\/[^\s/]*)$/.exec(textBeforeCursor)?.[1] : undefined;
		if (skillToken) {
			const skills = this.commands.filter(
				(cmd) => ("skill" in cmd && cmd.skill === true) || ("name" in cmd ? cmd.name : cmd.value).startsWith("skill:"),
			);
			return this.commandSuggestions(skillToken, skillToken.slice(1), skills);
		}

		const pathMatch = this.extractPathPrefix(textBeforeCursor, options.force ?? false);
		if (pathMatch === null) {
			return null;
		}

		const suggestions = await getFileSuggestions(this.basePath, pathMatch);
		if (suggestions.length === 0) return null;

		return {
			items: suggestions,
			prefix: pathMatch,
		};
	}

	private commandSuggestions(
		prefix: string,
		query: string,
		commands: (SlashCommand | AutocompleteItem)[],
	): AutocompleteSuggestions | null {
		const commandItems = commands.map((cmd) => {
			const name = "name" in cmd ? cmd.name : cmd.value;
			const hint = "argumentHint" in cmd && cmd.argumentHint ? cmd.argumentHint : undefined;
			const desc = cmd.description ?? "";
			// The short description leads so a long argument hint cannot push it off a narrow terminal.
			const detail = hint ? (desc ? `${desc} · ${hint}` : hint) : desc;
			const aliases = "aliases" in cmd ? (cmd.aliases ?? []) : [];
			return { name, label: name, aliases, description: detail || undefined };
		});

		const bareNameMatches = fuzzyFilter(commandItems, query, (item) =>
			item.name.startsWith("skill:") ? item.name.slice("skill:".length) : item.name,
		);
		const bareNameMatchSet = new Set(bareNameMatches);
		const fullNameOnlyMatches = fuzzyFilter(
			commandItems.filter((item) => item.name.startsWith("skill:") && !bareNameMatchSet.has(item)),
			query,
			(item) => item.name,
		);
		const listed = new Set([...bareNameMatches, ...fullNameOnlyMatches]);
		const aliasMatches = fuzzyFilter(
			commandItems.filter((item) => item.aliases.length > 0 && !listed.has(item)),
			query,
			(item) => item.aliases.join(" "),
		);
		// Enter runs the first row, so the command the query names in full (by its name or an alias) leads.
		const ranked = [...bareNameMatches, ...fullNameOnlyMatches, ...aliasMatches];
		const exact = ranked.findIndex((item) => item.name === query || item.aliases.includes(query));
		if (exact > 0) ranked.unshift(...ranked.splice(exact, 1));
		const filtered = ranked.map((item) => ({
			value: item.name,
			label: item.label,
			kind: "command" as const,
			...(item.description && { description: item.description }),
		}));

		if (filtered.length === 0) return null;
		return { items: filtered, prefix };
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

		// A command always goes in as `/name `, never its bare name: a bare name would be sent as a prompt. Slash commands
		// are otherwise at the start of the line and hold no path separator after the first `/`.
		const isSlashCommand =
			item.kind === "command" ||
			(prefix.startsWith("/") && !prefix.slice(1).includes("/") && beforePrefix.trim() === "");
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

	// Entries to rank for a scoped query (`src/x`, `../x`, `~/x`, `/abs/x`), paths relative to the scope directory.
	private async getScopedEntries(
		scope: { baseDir: string; query: string },
		signal: AbortSignal,
	): Promise<IndexedPath[]> {
		const inside = relative(this.basePath, scope.baseDir);
		if (!inside.startsWith("..") && !isAbsolute(inside)) {
			// Inside the working directory: reuse its index instead of walking again.
			const prefix = inside === "" ? "" : `${toDisplayPath(inside)}/`;
			const entries = await getFileIndex(this.basePath, this.fdPath);
			return entries
				.filter((entry) => entry.path.startsWith(prefix) && entry.path.length > prefix.length)
				.map((entry) => ({ path: entry.path.slice(prefix.length), isDirectory: entry.isDirectory }));
		}
		if (!this.fdPath) {
			// Outside the working directory without fd: a bounded walk of just that directory.
			return [...(await getFileIndex(scope.baseDir, null))];
		}
		// Outside the working directory: indexing a whole home or root would be too large, so ask fd for this query only.
		const [children, nested] = await Promise.all([
			walkDirectoryWithFd(scope.baseDir, this.fdPath, scope.query, 100, signal, 1),
			walkDirectoryWithFd(scope.baseDir, this.fdPath, scope.query, 100, signal),
		]);
		const seen = new Set<string>();
		return [...children, ...nested]
			.map((entry) => ({
				path: entry.isDirectory ? entry.path.slice(0, -1) : entry.path,
				isDirectory: entry.isDirectory,
			}))
			.filter((entry) => !seen.has(entry.path) && Boolean(seen.add(entry.path)));
	}

	private async rankIndex(
		scopedQuery: { baseDir: string; query: string; displayBase: string } | null,
		fuzzyQuery: string,
		signal: AbortSignal,
	): Promise<RankedPath[]> {
		const entries = scopedQuery
			? await this.getScopedEntries(scopedQuery, signal)
			: await getFileIndex(this.basePath, this.fdPath);
		if (signal.aborted) return [];

		const previous = this.lastRank;
		const narrowed =
			previous && previous.source === entries && previous.query !== "" && fuzzyQuery.startsWith(previous.query);
		let matched: IndexedPath[] | undefined;
		const ranked = await rankPaths(narrowed ? previous.matched : entries, fuzzyQuery, {
			signal,
			onMatches: (all) => {
				matched = all;
			},
		});
		// An aborted ranking saw only part of the entries: keep the previous narrowing instead of a partial one.
		if (signal.aborted) return [];
		this.lastRank = matched && fuzzyQuery !== "" ? { source: entries, query: fuzzyQuery, matched } : undefined;
		return ranked;
	}

	// Fuzzy file search over the per-directory file index (fd when available, else git or a bounded walk)
	private async getFuzzyFileSuggestions(
		query: string,
		options: { isQuotedPrefix: boolean; signal: AbortSignal },
	): Promise<AutocompleteItem[]> {
		if (options.signal.aborted) {
			return [];
		}

		try {
			const scopedQuery = await resolveScopedFuzzyQuery(this.basePath, query);
			const fuzzyQuery = scopedQuery?.query ?? query;
			let ranked = await this.rankIndex(scopedQuery, fuzzyQuery, options.signal);
			// The cached index may predate the file the user means (a new file, a checkout): when nothing matched,
			// rebuild it now (or join the running rebuild), wait once and rank again.
			const refresh =
				ranked.length === 0 && !options.signal.aborted ? refreshFileIndexNow(this.basePath, this.fdPath) : null;
			if (refresh) {
				await refresh;
				ranked = await this.rankIndex(scopedQuery, fuzzyQuery, options.signal);
			}
			if (options.signal.aborted) {
				return [];
			}
			return ranked.map(({ path: entryPath, isDirectory, positions }) => {
				const displayPath = scopedQuery ? scopedPathForDisplay(scopedQuery.displayBase, entryPath) : entryPath;
				const completionPath = isDirectory ? `${displayPath}/` : displayPath;
				const matches = basenameMatches(entryPath, positions);
				return {
					value: buildCompletionValue(completionPath, {
						isDirectory,
						isAtPrefix: true,
						isQuotedPrefix: options.isQuotedPrefix,
					}),
					label: basename(entryPath) + (isDirectory ? "/" : ""),
					description: displayPath,
					kind: isDirectory ? "directory" : "file",
					...(matches.length > 0 && { matches }),
				};
			});
		} catch {
			return [];
		}
	}

	indexingStatus(): string | null {
		const status = getFileIndexStatus(this.basePath);
		if (status.state !== "building") return null;
		return `Indexing… ${String(status.count).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} files`;
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
