import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import { trustedMcpOptions } from "./mcp-trust.ts";
import { createMcpExtension } from "./mcp/index.ts";
import { prepareOctocodeSkillLaunch } from "../octocode/mcp/skill-paths.ts";
import { createToolSearchExtension } from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `tool_search` or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
	{
		name: "mcp",
		factory: (pi) =>
			createMcpExtension({
				...trustedMcpOptions(pi),
				prepareLaunch: (entry, cwd) => prepareOctocodeSkillLaunch(entry, cwd, pi.getSkillDirectories()),
			})(pi),
		replaceable: true,
		builtin: true,
	},
];
