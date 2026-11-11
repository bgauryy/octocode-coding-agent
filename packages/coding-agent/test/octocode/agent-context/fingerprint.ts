import type { SystemMessage } from "@octocodeai/octocode-ai";
import { splitSystemMessageIntoBlocks } from "@octocodeai/octocode-ai/utils/instruction-split";
import { NON_BASE_SECTIONS, VOLATILE_SECTIONS } from "../../../src/core/system-prompt-spec.ts";
import { declaration } from "./analyze.ts";
import type { AgentContext } from "./capture.ts";

const LOOSE = "(system text outside a section)";

/** The tool array the request declares: every tool in order with its description and parameter schema. */
export const toolsText = (context: AgentContext): string => `[${context.tools.map(declaration).join(",")}]`;

/**
 * The instruction blocks the request sends: the base block (content and the sections before the first section outside
 * the base tier), the session block (from that section up to the first volatile one) and the volatile block (the
 * rest, sent without a cache breakpoint), cut where `instructionCacheBoundaryOption` cuts, or the whole prompt when
 * nothing is cut. Texts are the normalized ones of the rendered files, so they do not depend on the machine.
 */
export function instructionBlocks(context: AgentContext): { base: string; session?: string; volatile?: string } {
	const loose = context.sections.find((section) => section.name === LOOSE)?.text ?? "";
	const sections = Object.fromEntries(
		context.sections.filter((section) => section.name !== LOOSE).map((section) => [section.name, section.text]),
	);
	const message: SystemMessage = { role: "system", content: loose, sections, timestamp: 0 };
	const boundary = Object.keys(sections).find((name) => NON_BASE_SECTIONS.has(name));
	const volatileBoundary = Object.keys(sections).find((name) => VOLATILE_SECTIONS.has(name));
	const split = splitSystemMessageIntoBlocks(message, boundary, volatileBoundary);
	if (split) {
		return {
			base: split.cached[0],
			...(split.cached.length > 1 ? { session: split.cached[1] } : {}),
			...(split.volatile === undefined ? {} : { volatile: split.volatile }),
		};
	}
	return { base: [loose, ...Object.values(sections)].filter((part) => part.length > 0).join("\n\n") };
}
