import { isMcpToolName } from "@octocodeai/octocode-common/mcp-names";
import { skillListingBudgetChars } from "./skills/listing-budget.ts";

/**
 * The size warnings `/context` and `octocode context check` give: one MCP server's instructions, or the project's
 * context files together, over 1% of the context window (the skill listing's share, `skillListingBudgetChars`), and one
 * MCP server's declared tools over 5% of it. Nothing is ever cut for it: the prompt is the same with or without the
 * warning.
 */

/**
 * One server's tool declarations may take five times the instructions budget (5% of the window): tool schemas are
 * larger than prose by nature, and past that share deferring the server's tools pays for the load it costs.
 */
const DECLARED_TOOLS_BUDGET_MULTIPLE = 5;

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

/** A tool declaration as the request carries it: what `/context` counts for each declared tool. */
export const declarationChars = (tool: object): number => JSON.stringify(tool).length;

/** The MCP server a declared tool belongs to: the `<server>` of `mcp__<server>__<tool>`; undefined for a native tool. */
export function mcpToolServer(name: string): string | undefined {
	if (!isMcpToolName(name)) return undefined;
	return name.slice("mcp__".length).split("__")[0];
}

/** Each MCP server's declared tools (`mcp__<server>__…`): how many, and the characters their declarations take. */
export function mcpToolSizes(
	tools: ReadonlyArray<{ name: string }>,
): Array<{ server: string; tools: number; chars: number }> {
	const sizes = new Map<string, { server: string; tools: number; chars: number }>();
	for (const tool of tools) {
		const server = mcpToolServer(tool.name);
		if (server === undefined) continue;
		const size = sizes.get(server) ?? { server, tools: 0, chars: 0 };
		size.tools += 1;
		size.chars += declarationChars(tool);
		sizes.set(server, size);
	}
	return [...sizes.values()];
}

/** The `<project_context>` block of a rendered system prompt (its head and every file): the context files as the model reads them. */
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
	/** The session's model, for its characters per token. */
	model?: { id: string } | undefined;
}): { text: string; details: string[] } | undefined {
	const [text] = contextSizeWarnings({
		servers: [],
		contextFilesChars: projectContextOf(input.systemPrompt)?.length ?? 0,
		contextWindow: input.contextWindow,
		model: input.model,
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
	/** Each MCP server's declared tools as the request carries them (`mcpToolSizes`); absent: not checked. */
	tools?: ReadonlyArray<{ server: string; chars: number }>;
	/** The project's context files together, as the prompt carries them. */
	contextFilesChars: number;
	contextWindow?: number | null | undefined;
	/** The model the window belongs to: its family's characters per token size the budgets (`skillListingBudgetChars`). */
	model?: { id: string } | undefined;
}): string[] {
	const budget = skillListingBudgetChars(input.contextWindow ?? undefined, input.model);
	const toolsBudget = budget * DECLARED_TOOLS_BUDGET_MULTIPLE;
	const largestFirst = <T extends { chars: number }>(parts: ReadonlyArray<T>, limit: number) =>
		parts.filter((part) => part.chars > limit).sort((a, b) => b.chars - a.chars);
	return [
		...largestFirst(input.servers, budget).map(
			(server) =>
				`MCP server ${server.server} instructions too long: ${server.chars} chars, budget ${budget} · fix: disable the server in /mcp, or ask its maintainer to shorten its instructions`,
		),
		...largestFirst(input.tools ?? [], toolsBudget).map(
			(server) =>
				`MCP server ${server.server} tool declarations too long: ${server.chars} chars, budget ${toolsBudget} · fix: defer its tools with /mcp exposure, or disable the server in /mcp`,
		),
		...(input.contextFilesChars > budget
			? [
					`Context files too long: ${input.contextFilesChars} chars, budget ${budget} · move rarely needed rules into linked files`,
				]
			: []),
	];
}
