import { getInitialSystemMessage, type ProviderEnv, type StreamOptions } from "@octocodeai/octocode-ai";
import { getProviderEnvValue } from "@octocodeai/octocode-ai/utils/provider-env";

/** Set to `off` to send the leading system prompt as one instruction cache block. */
const INSTRUCTION_CACHE_SPLIT_ENV = "OCTOCODE_INSTRUCTION_CACHE_SPLIT";

/**
 * The sections that open the project- and session-specific part of the prompt. Everything before the first of them
 * (preamble, tools, rules, docs and base sections such as MCP server files) depends only on the tools and the install.
 */
const SESSION_SECTIONS: ReadonlySet<string> = new Set(["addendum", "project_context", "skills", "cwd", "environment"]);

/**
 * The first session section of the leading system message (`addendum`, `project_context`, `skills`, `cwd` or
 * `environment`): where the second instruction cache block starts. Undefined for a forced prompt, which has no
 * sections, and when no session section is present.
 */
export function findInstructionCacheBoundary(messages: readonly { role: string }[]): string | undefined {
	const sections = getInitialSystemMessage(messages)?.sections;
	if (!sections) return undefined;
	return Object.entries(sections).find(([name, text]) => text !== null && SESSION_SECTIONS.has(name))?.[0];
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
