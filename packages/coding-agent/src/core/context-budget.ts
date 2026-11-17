import { skillListingBudgetChars } from "./skills/listing-budget.ts";

/**
 * The size warnings `/context` and `octocode context check` give: one MCP server's instructions, or the project's
 * context files together, over 1% of the context window (the skill listing's share, `skillListingBudgetChars`). Nothing
 * is ever cut for it: the prompt is the same with or without the warning.
 */

/** A server's instructions inside the text the prompt carries for it: all of it, or the comment before its typed functions. */
function instructionChars(contract: string): number {
	const functions = contract.indexOf("declare namespace ");
	if (functions < 0) return contract.trim().length;
	const comment = /^\/\*\* (.*) \*\/$/m.exec(contract.slice(0, functions));
	return comment?.[1]?.length ?? 0;
}

/** Each server block of a rendered `mcps` section (`sections/mcp-server.md`) with the size of its instructions. */
export function mcpInstructionSizes(mcpsSection: string): Array<{ server: string; chars: number }> {
	return [...mcpsSection.matchAll(/^<mcp name="([^"]*)"[^>]*>\n([\s\S]*?)\n<\/mcp>$/gm)].map((block) => ({
		server: block[1] ?? "",
		chars: instructionChars(block[2] ?? ""),
	}));
}

/** The size of the instructions in a server's generated file (`octocode mcp compact`), which holds its typed functions too. */
export function generatedInstructionChars(text: string): number {
	return text.includes("declare namespace ") ? instructionChars(text) : 0;
}

/** The `<project_context>` blocks of a rendered system prompt (its head and one per file): the context files as the model reads them. */
export function projectContextOf(systemPrompt: string): string | undefined {
	const pattern = /^<project_context>$[\s\S]*?^<\/project_context>$/gm;
	const blocks: string[] = [];
	for (let match = pattern.exec(systemPrompt); match; match = pattern.exec(systemPrompt)) blocks.push(match[0]);
	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

/**
 * The startup warning when the project's context files (AGENTS.md and the like) together pass the budget: the shared
 * message, with each file's size largest first, so the user sees which file to shorten. Undefined when they fit.
 */
export function contextFilesBudgetWarning(input: {
	systemPrompt: string;
	files: ReadonlyArray<{ path: string; content: string }>;
	contextWindow?: number | null | undefined;
}): { text: string; details: string[] } | undefined {
	const [text] = contextSizeWarnings({
		servers: [],
		contextFilesChars: projectContextOf(input.systemPrompt)?.length ?? 0,
		contextWindow: input.contextWindow,
	});
	if (!text) return undefined;
	const details = [...input.files]
		.sort((a, b) => b.content.length - a.content.length)
		.map((file) => `${file.path}: ${file.content.length} chars`);
	return { text, details };
}

/** One warning per part over the budget, largest servers first; empty when everything fits. */
export function contextSizeWarnings(input: {
	servers: ReadonlyArray<{ server: string; chars: number }>;
	/** The project's context files together, as the prompt carries them. */
	contextFilesChars: number;
	contextWindow?: number | null | undefined;
}): string[] {
	const budget = skillListingBudgetChars(input.contextWindow ?? undefined);
	const over = (chars: number) => `${chars} chars, budget ${budget}`;
	return [
		...input.servers
			.filter((server) => server.chars > budget)
			.sort((a, b) => b.chars - a.chars)
			.map(
				(server) =>
					`MCP server ${server.server} instructions too long: ${over(server.chars)} · fix: octocode mcp compact --help`,
			),
		...(input.contextFilesChars > budget
			? [`Context files too long: ${over(input.contextFilesChars)} · move rarely needed rules into linked files`]
			: []),
	];
}
