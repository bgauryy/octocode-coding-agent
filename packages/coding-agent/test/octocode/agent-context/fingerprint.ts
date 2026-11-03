import type { SystemMessage } from "@octocodeai/octocode-ai";
import { splitSystemMessageAtBoundary } from "@octocodeai/octocode-ai/utils/instruction-split";
import { NON_BASE_SECTIONS } from "../../../src/core/system-prompt-spec.ts";
import { declaration } from "./analyze.ts";
import type { AgentContext } from "./capture.ts";

const LOOSE = "(system text outside a section)";

/** The tool array the request declares: every tool in order with its description and parameter schema. */
export const toolsText = (context: AgentContext): string => `[${context.tools.map(declaration).join(",")}]`;

/**
 * The instruction blocks the request sends: the base block (content and the sections before the first section outside
 * the base tier) and the session block (that section and the rest), cut where `instructionCacheBoundaryOption` cuts,
 * or the whole prompt when nothing is cut. Texts are the normalized ones of the rendered files, so they do not depend
 * on the machine.
 */
export function instructionBlocks(context: AgentContext): { base: string; session?: string } {
	const loose = context.sections.find((section) => section.name === LOOSE)?.text ?? "";
	const sections = Object.fromEntries(
		context.sections.filter((section) => section.name !== LOOSE).map((section) => [section.name, section.text]),
	);
	const message: SystemMessage = { role: "system", content: loose, sections, timestamp: 0 };
	const boundary = Object.keys(sections).find((name) => NON_BASE_SECTIONS.has(name));
	const split = splitSystemMessageAtBoundary(message, boundary);
	if (split) return { base: split[0], session: split[1] };
	return { base: [loose, ...Object.values(sections)].filter((part) => part.length > 0).join("\n\n") };
}
