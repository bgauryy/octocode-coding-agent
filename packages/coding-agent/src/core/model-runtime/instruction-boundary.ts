import { getInitialSystemMessage, type ProviderEnv, type StreamOptions } from "@octocodeai/octocode-ai";
import { getProviderEnvValue } from "@octocodeai/octocode-ai/utils/provider-env";
import { NON_BASE_SECTIONS } from "../system-prompt-spec.ts";

/** Set to `off` to send the leading system prompt as one instruction cache block. */
const INSTRUCTION_CACHE_SPLIT_ENV = "OCTOCODE_INSTRUCTION_CACHE_SPLIT";

/**
 * The first known section of the leading system message outside the base tier (`system-prompt-spec.ts`): where the
 * second instruction cache block starts. Everything before it (preamble, tools, rules, docs, `mcps` and extension base
 * sections) depends only on the tools and the install. Undefined for a forced prompt, which has no sections, and when
 * no such section is present.
 */
export function findInstructionCacheBoundary(messages: readonly { role: string }[]): string | undefined {
	const sections = getInitialSystemMessage(messages)?.sections;
	if (!sections) return undefined;
	return Object.entries(sections).find(([name, text]) => text !== null && NON_BASE_SECTIONS.has(name))?.[0];
}

/**
 * The `instructionCacheBoundary` request option for a transcript. A caller-supplied value wins, and
 * `OCTOCODE_INSTRUCTION_CACHE_SPLIT=off` sends none.
 */
export function instructionCacheBoundaryOption(
	messages: readonly { role: string }[],
	options?: Pick<StreamOptions, "instructionCacheBoundary"> & { env?: ProviderEnv },
): Pick<StreamOptions, "instructionCacheBoundary"> {
	if (options?.instructionCacheBoundary !== undefined) return {};
	if (getProviderEnvValue(INSTRUCTION_CACHE_SPLIT_ENV, options?.env)?.trim().toLowerCase() === "off") return {};
	const boundary = findInstructionCacheBoundary(messages);
	return boundary ? { instructionCacheBoundary: boundary } : {};
}
