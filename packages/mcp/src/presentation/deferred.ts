/** The block of a server with deferred tools: the direct ones in full, then one index line per deferred one. */

import type { McpDeferral } from "../deferral.ts";
import { firstSentence } from "./declaration.ts";
import { jsonContract } from "./json-block.ts";

/**
 * The head of a block with no tool: the generated file up to its `declare namespace` line (the call-name note and the
 * instructions), or in plain form the header and the instructions.
 */
export function instructionsHead(
	generated: { callName: string; text: string },
	instructions: string | undefined,
): string {
	if (!generated.text) return instructions?.trim() ? jsonContract(generated.callName, instructions, []) : "";
	const lines = generated.text.split("\n");
	const end = lines.findIndex((line) => line.startsWith("declare namespace "));
	return lines.slice(0, Math.max(0, end)).join("\n").trimEnd();
}

interface ResidentInput {
	offered: readonly string[];
	deferral: McpDeferral;
	/** Bytes of the direct blocks of the servers that sort before this one. */
	spent: number;
	/** The full block text of the given tools (with the instructions when any is given). */
	contractOf: (tools: readonly string[]) => { file: string | undefined; text: string; bytes?: number };
	indexLine: (tool: string) => string;
	/** The index line of an undeclared (on-demand) tool: its name and trigger. */
	onDemandLine: (tool: string) => string;
	/** The server's instructions as the direct block shows them, with no tool: empty without instructions. */
	instructionsOf: () => string;
}

/**
 * Tools the configuration defers are deferred; open tools under an auto budget are deferred too when the direct blocks
 * described so far plus this one pass it. A server whose every tool is deferred still shows its instructions, as a
 * direct block does; only the tools' descriptions and schemas are left to the `mcp` tool.
 */
export function residentBlock({
	offered,
	deferral,
	spent,
	contractOf,
	indexLine,
	onDemandLine,
	instructionsOf,
}: ResidentInput) {
	let deferred = new Set(offered.filter((tool) => deferral.deferred.has(tool)));
	const directOf = () => contractOf(offered.filter((tool) => !deferred.has(tool)));
	let direct = directOf();
	const open = offered.filter((tool) => deferral.auto?.tools.has(tool) && !deferred.has(tool));
	const sizeOf = (block: { text: string; bytes?: number }) => block.bytes ?? Buffer.byteLength(block.text);
	if (deferral.auto && open.length > 0 && spent + sizeOf(direct) > deferral.auto.budget) {
		deferred = new Set([...deferred, ...open]);
		direct = directOf();
	}
	const onDemand = [...(deferral.onDemand ?? [])].filter((tool) => !offered.includes(tool));
	const index = [...offered.filter((tool) => deferred.has(tool)).map(indexLine), ...onDemand.map(onDemandLine)];
	// With no direct tool the block's head would be missing: the instructions come first.
	const head = direct.text || (index.length > 0 ? instructionsOf() : "");
	return {
		file: direct.file,
		text: [head, ...index].filter(Boolean).join("\n"),
		direct: head,
		/** Bytes the direct tools cost, which an `auto:<bytes>` budget counts: the block's text, or their declarations. */
		directBytes: direct.text ? sizeOf(direct) : Buffer.byteLength(head),
		deferred: deferred as ReadonlySet<string>,
		onDemand: new Set(onDemand) as ReadonlySet<string>,
	};
}

/**
 * The trigger of an on-demand tool's index line: the description's `<when>` text, else its first sentence. The line is
 * all the model reads of the tool before it loads it.
 */
export function onDemandTrigger(description: string | undefined): string | undefined {
	if (!description) return undefined;
	const when = /<when>([\s\S]*?)<\/when>/i.exec(description)?.[1]?.replace(/\s+/g, " ").trim();
	return when || firstSentence(description) || undefined;
}
