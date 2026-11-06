/** The block of a server with deferred tools: the direct ones in full, then one index line per deferred one. */

import type { DescriptionOverrides } from "../compact/index.ts";
import type { McpDeferral } from "../deferral.ts";
import { firstSentence } from "./declaration.ts";
import { jsonContract } from "./json-block.ts";

/** A thin declaration's and an index line's trigger: the preset's, else the first sentence of its rewritten description. */
export function authoredTrigger(overrides: DescriptionOverrides | undefined, tool: string): string | undefined {
	const trigger = overrides?.triggers?.[tool]?.trim();
	if (trigger) return trigger;
	const description = overrides?.tools?.[tool];
	return description ? firstSentence(description) : undefined;
}

/**
 * The head of a block with no tool: the generated file up to its `declare namespace` line (the call-name note and the
 * instructions, with the preset's wording), or in plain form the header and the instructions.
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
	/** A deferred tool's index line. */
	indexLine: (tool: string) => string;
	/** The server's instructions as the direct block shows them, with no tool: empty without instructions. */
	instructionsOf: () => string;
}

/**
 * Tools the configuration defers are deferred; open tools under an auto budget are deferred too when the direct blocks
 * described so far plus this one pass it. A server whose every tool is deferred still shows its instructions, as a
 * direct block does; only the tools' descriptions and schemas are left to the `mcp` tool.
 */
export function residentBlock({ offered, deferral, spent, contractOf, indexLine, instructionsOf }: ResidentInput) {
	let deferred = new Set(offered.filter((tool) => deferral.deferred.has(tool)));
	const directOf = () => contractOf(offered.filter((tool) => !deferred.has(tool)));
	let direct = directOf();
	const open = offered.filter((tool) => deferral.auto?.tools.has(tool) && !deferred.has(tool));
	const sizeOf = (block: { text: string; bytes?: number }) => block.bytes ?? Buffer.byteLength(block.text);
	if (deferral.auto && open.length > 0 && spent + sizeOf(direct) > deferral.auto.budget) {
		deferred = new Set([...deferred, ...open]);
		direct = directOf();
	}
	const index = offered.filter((tool) => deferred.has(tool)).map(indexLine);
	// With no direct tool the block's head would be missing: the instructions come first.
	const head = direct.text || (index.length > 0 ? instructionsOf() : "");
	return {
		file: direct.file,
		text: [head, ...index].filter(Boolean).join("\n"),
		direct: head,
		/** Bytes the direct tools cost, which an `auto:<bytes>` budget counts: the block's text, or their declarations. */
		directBytes: direct.text ? sizeOf(direct) : Buffer.byteLength(head),
		deferred: deferred as ReadonlySet<string>,
	};
}
