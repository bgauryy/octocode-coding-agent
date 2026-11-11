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

/** One warning per part over the budget, largest servers first; empty when everything fits. */
export function contextSizeWarnings(input: {
	servers: ReadonlyArray<{ server: string; chars: number }>;
	/** The project's context files together, as the prompt carries them. */
	contextFilesChars: number;
	contextWindow?: number | null | undefined;
}): string[] {
	const budget = skillListingBudgetChars(input.contextWindow ?? undefined);
	const over = (chars: number) => `${chars} chars > ${budget} budget (1% of the context window). Nothing is cut.`;
	return [
		...input.servers
			.filter((server) => server.chars > budget)
			.sort((a, b) => b.chars - a.chars)
			.map(
				(server) =>
					`MCP server ${server.server} instructions over budget: ${over(server.chars)} Shorten them in the server, or override them for this install (\`octocode mcp compact --help\`).`,
			),
		...(input.contextFilesChars > budget
			? [
					`Context files over budget: ${over(input.contextFilesChars)} Keep the rules every task needs, and move the rest into files the agent reads when it needs them.`,
				]
			: []),
	];
}
