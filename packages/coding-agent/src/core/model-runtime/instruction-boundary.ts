import { getInitialSystemMessage, type ProviderEnv, type StreamOptions } from "@octocodeai/octocode-ai";
import { getProviderEnvValue } from "@octocodeai/octocode-ai/utils/provider-env";
import { NON_BASE_SECTIONS, VOLATILE_SECTIONS } from "../system-prompt-spec.ts";
import { findToolCacheBoundary } from "../tool-roles.ts";

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
 * The first of the volatile sections that end the leading system message (`system-prompt-spec.ts`): where the trailing
 * instruction block starts, which is sent without a cache breakpoint. A volatile section that a session section still
 * follows does not count, so a session saved when `cwd` preceded the policy keeps its policy in a cached block.
 * Undefined for a forced prompt and when the prompt does not end with a volatile section.
 */
export function findInstructionVolatileBoundary(messages: readonly { role: string }[]): string | undefined {
	const sections = getInitialSystemMessage(messages)?.sections;
	if (!sections) return undefined;
	let boundary: string | undefined;
	for (const [name, text] of Object.entries(sections).reverse()) {
		if (text === null) continue;
		if (!VOLATILE_SECTIONS.has(name)) break;
		boundary = name;
	}
	return boundary;
}

type BoundaryOptions = Pick<
	StreamOptions,
	"instructionCacheBoundary" | "instructionVolatileBoundary" | "toolCacheBoundary"
>;

/**
 * The `instructionCacheBoundary`, `instructionVolatileBoundary` and `toolCacheBoundary` request options for a
 * transcript. A caller-supplied value wins, each on its own, and `OCTOCODE_INSTRUCTION_CACHE_SPLIT=off` sends none: the
 * tool boundary is one more instruction breakpoint.
 * `roleVariantTools` names the declared tools whose definition is `roleVariant`; without it no tool boundary is set.
 */
export function instructionCacheBoundaryOption(
	messages: readonly { role: string }[],
	options?: BoundaryOptions & { env?: ProviderEnv; roleVariantTools?: ReadonlySet<string> },
): BoundaryOptions {
	if (getProviderEnvValue(INSTRUCTION_CACHE_SPLIT_ENV, options?.env)?.trim().toLowerCase() === "off") return {};
	const boundary = options?.instructionCacheBoundary === undefined ? findInstructionCacheBoundary(messages) : undefined;
	const volatile =
		options?.instructionVolatileBoundary === undefined ? findInstructionVolatileBoundary(messages) : undefined;
	const tools =
		options?.toolCacheBoundary === undefined
			? findToolCacheBoundary(
					(getInitialSystemMessage(messages)?.toolsAdded ?? []).map((tool) => tool.name),
					(name) => options?.roleVariantTools?.has(name) === true,
				)
			: undefined;
	return {
		...(boundary ? { instructionCacheBoundary: boundary } : {}),
		...(volatile ? { instructionVolatileBoundary: volatile } : {}),
		...(tools ? { toolCacheBoundary: tools } : {}),
	};
}
