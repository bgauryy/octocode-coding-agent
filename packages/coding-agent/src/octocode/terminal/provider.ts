import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@octocodeai/octocode-tui";
import type { ShellCompletionService } from "../../../../terminal/src/index.ts";

/** The `!` or `!!` that starts a shell line, with the spaces after it, or undefined for any other line. */
export function shellPrefix(lines: string[], cursorLine: number): string | undefined {
	if (cursorLine !== 0) return undefined;
	return /^\s*!!?\s*/.exec(lines[0] ?? "")?.[0];
}

/** An item this provider made: it carries whether accepting it adds a space after it. */
interface ShellItem extends AutocompleteItem {
	shellNoSpace: boolean;
}

const isShellItem = (item: AutocompleteItem): item is ShellItem =>
	typeof (item as Partial<ShellItem>).shellNoSpace === "boolean";

/**
 * Tab completion for `!` lines from the user's shell (`ShellCompletionService`), wrapping the built-in provider. Only a
 * forced request (Tab, or typing while the Tab list is open) asks the shell; the list never opens by itself. Other lines,
 * and a `!` line the shell has nothing for, go to the built-in provider, which completes file paths.
 */
export class ShellAwareProvider implements AutocompleteProvider {
	readonly triggerCharacters: string[] | undefined;
	private readonly base: AutocompleteProvider;
	private readonly service: () => ShellCompletionService | undefined;

	constructor(base: AutocompleteProvider, service: () => ShellCompletionService | undefined) {
		this.base = base;
		this.service = service;
		this.triggerCharacters = base.triggerCharacters;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const prefix = shellPrefix(lines, cursorLine);
		const service = this.service();
		if (prefix === undefined || !options.force || !service || cursorCol < prefix.length)
			return this.base.getSuggestions(lines, cursorLine, cursorCol, options);
		const text = (lines[0] ?? "").slice(prefix.length, cursorCol);
		let result: Awaited<ReturnType<ShellCompletionService["complete"]>>;
		try {
			result = await service.complete(text, options.signal);
		} catch {
			result = undefined;
		}
		if (options.signal.aborted) return null;
		if (!result?.items.length) return this.base.getSuggestions(lines, cursorLine, cursorCol, options);
		return {
			prefix: text.slice(result.start),
			items: result.items.map((item): ShellItem => ({
				value: item.value,
				label: item.label,
				...(item.description ? { description: item.description } : {}),
				...(item.kind ? { kind: item.kind } : {}),
				shellNoSpace: item.noSpace === true,
			})),
		};
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const shellLine = shellPrefix(lines, cursorLine);
		if (shellLine === undefined || !isShellItem(item))
			return this.base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		const line = lines[cursorLine] ?? "";
		const before = line.slice(0, cursorCol - prefix.length);
		const after = line.slice(cursorCol);
		const space = item.shellNoSpace || after.startsWith(" ") ? "" : " ";
		const inserted = `${item.value}${space}`;
		const next = [...lines];
		next[cursorLine] = before + inserted + after;
		return { lines: next, cursorLine, cursorCol: before.length + inserted.length };
	}

	indexingStatus(): string | null {
		return this.base.indexingStatus?.() ?? null;
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		if (shellPrefix(lines, cursorLine) !== undefined) return true;
		return this.base.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
	}
}
