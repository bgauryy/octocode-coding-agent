import type { AgentContext } from "./capture.ts";

export type PartKind = "system section" | "native tool" | "MCP tool" | "message";

/** One measurable piece of an agent's first request. */
export interface Part {
	kind: PartKind;
	name: string;
	chars: number;
}

export const KINDS: PartKind[] = ["system section", "native tool", "MCP tool", "message"];

/** A tool declaration as the model receives it: name, description and parameter schema. */
export function declaration(tool: AgentContext["tools"][number]): string {
	return JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters });
}

export const isMcpTool = (name: string): boolean => name.startsWith("mcp__");

export function partsOf(context: AgentContext): Part[] {
	return [
		...context.sections.map((section) => ({
			kind: "system section" as const,
			name: section.name,
			chars: section.text.length,
		})),
		...context.tools.map((tool) => ({
			kind: (isMcpTool(tool.name) ? "MCP tool" : "native tool") as PartKind,
			name: tool.name,
			chars: declaration(tool).length,
		})),
		...context.messages.map((message, index) => ({
			kind: "message" as const,
			name: `${message.role} message ${index + 1}`,
			chars: message.text.length,
		})),
	];
}

export const sum = (parts: readonly Part[]): number => parts.reduce((total, part) => total + part.chars, 0);

export const byKind = (parts: readonly Part[], kind: PartKind): Part[] => parts.filter((part) => part.kind === kind);

/** Descending by size; ties by name so the order is stable. */
export const largestFirst = (parts: readonly Part[]): Part[] =>
	[...parts].sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));

export const tokens = (chars: number): number => Math.ceil(chars / 4);

export const number = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A sentence found in more than one place of one agent's context. */
export interface Repeat {
	sentence: string;
	/** Distinct places it appears in. */
	sources: string[];
	/** Characters spent on the extra copies. */
	wasted: number;
}

const MIN_SENTENCE = 50;

/** Every string a schema describes itself with (`description` values), so repeated property docs count too. */
function schemaDescriptions(value: unknown, found: string[] = []): string[] {
	if (Array.isArray(value)) for (const item of value) schemaDescriptions(item, found);
	else if (value && typeof value === "object")
		for (const [key, item] of Object.entries(value)) {
			if (key === "description" && typeof item === "string") found.push(item);
			else schemaDescriptions(item, found);
		}
	return found;
}

function sentences(text: string): string[] {
	return text
		.split(/\n+/)
		.map((line) => line.replace(/^\s*(?:[-*]|\d+\.|#+)\s+/, "").trim())
		.flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z`"'(<[])/))
		.map((sentence) => sentence.replace(/\s+/g, " ").trim())
		.filter((sentence) => sentence.length >= MIN_SENTENCE);
}

/**
 * Sentences of at least 50 characters that appear, word for word, in two or more places of one agent's context (system
 * sections, tool descriptions and schema descriptions, messages). They are candidates to say once; nothing here fails a
 * test. Largest waste first.
 */
export function repeatedSentences(context: AgentContext): Repeat[] {
	const places: Array<[string, string]> = [
		...context.sections.map((section): [string, string] => [`\`${section.name}\``, section.text]),
		...context.tools.flatMap((tool): Array<[string, string]> => [
			[`tool \`${tool.name}\``, tool.description],
			...schemaDescriptions(tool.parameters).map((text): [string, string] => [`tool \`${tool.name}\``, text]),
		]),
		...context.messages.map((message, index): [string, string] => [
			`${message.role} message ${index + 1}`,
			message.text,
		]),
	];
	const seen = new Map<string, Set<string>>();
	for (const [place, text] of places)
		for (const sentence of sentences(text)) {
			const where = seen.get(sentence) ?? new Set<string>();
			where.add(place);
			seen.set(sentence, where);
		}
	return [...seen]
		.filter(([, where]) => where.size > 1)
		.map(([sentence, where]) => ({
			sentence,
			sources: [...where],
			wasted: sentence.length * (where.size - 1),
		}))
		.sort((a, b) => b.wasted - a.wasted || a.sentence.localeCompare(b.sentence));
}
