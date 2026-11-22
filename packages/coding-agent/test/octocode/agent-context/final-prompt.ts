import { isMcpTool } from "./analyze.ts";
import { AGENTS, type AgentContext, type CapturedTool } from "./capture.ts";
import { systemText } from "./render.ts";

/**
 * The committed `src/octocode/native/prompts/final/<agent>.md`: each agent's final system prompt and tool declarations with
 * every part that varies by machine, user, session or configuration replaced by a `{{PLACEHOLDER}}`.
 *
 * The prompt builder wraps each dynamic part in a tag of its own (`<mcps>`, `<skills>`, `<environment>`...), so the
 * placeholders replace whole tagged blocks rather than matching their text: a new server, skill or platform line cannot
 * leak through, and a change to our own static text still shows. Only the two bash host lines and the MCP lines of the
 * `<tools>` list are matched by their shape.
 */
export const REGENERATE_COMMAND = "yarn workspace @octocodeai/octocode-agent run generate:prompts";

export const PLACEHOLDERS: Array<{ name: string; stands: string; renderedBy: string }> = [
	{
		name: "MCP_SERVERS",
		stands: "The `<mcps>` block: the instructions of every MCP server the user enabled, one `<mcp>` element each.",
		renderedBy: "`packages/mcp/src/section.ts` (`renderMcpsSection`)",
	},
	{
		name: "MCP_TOOL_SUMMARIES",
		stands: "The `- mcp__<server>__*: ...` lines of the `<tools>` list, one per enabled MCP server.",
		renderedBy: "`packages/mcp/src/section.ts` and the tool snippets of `src/octocode/native/tools/`",
	},
	{
		name: "MCP_TOOLS",
		stands: "The `mcp__<server>__<tool>` declarations (description and schema) of the enabled MCP servers.",
		renderedBy: "`packages/mcp/src/tool-definition.ts`; the servers come from the user's MCP configuration",
	},
	{
		name: "CWD",
		stands: "The absolute path of the working directory.",
		renderedBy: "`src/core/system-prompt.ts`",
	},
	{
		name: "PROJECT_CONTEXT",
		stands:
			"The `<project_context>` block: the AGENTS.md / CLAUDE.md files of the working directory and its ancestors.",
		renderedBy:
			"`src/octocode/native/prompts/system/project-context.md`, files loaded by `src/core/resource-loader.ts`",
	},
	{
		name: "SKILLS_LIST",
		stands:
			"The `path: description` lines at the end of the `skill` tool's description: the skills this agent may load (bundled, user and project skills).",
		renderedBy: "`src/octocode/native/tools/skill/description.md` and `src/core/skills/listing.ts`",
	},
	{
		name: "HARNESSES",
		stands: "The `<harnesses>` block: which other agents' hooks, MCP servers and memory files are on or off.",
		renderedBy: "`src/octocode/` harness switch (`/harness`)",
	},
	{
		name: "ENVIRONMENT",
		stands: "The `<environment>` block: platform, shell and today's date.",
		renderedBy: "`src/octocode/native/prompts/system/environment.md`",
	},
	{
		name: "HOST_PROBE",
		stands:
			"The two `Host:` / `Host notes:` lines of the bash description: the probed OS, tools on PATH and platform notes.",
		renderedBy: "`src/octocode/files/bash/cli-guide.ts`",
	},
];

const block = (tag: string, body: string): string => `<${tag}>\n${body}\n</${tag}>`;

/**
 * Replaces the whole `<tag>...</tag>` block, keeping the tag lines; consecutive blocks of one tag (a section family's
 * head and members) become one. A missing block stays missing.
 */
function swapBlock(text: string, tag: string, placeholder: string): string {
	const one = `^<${tag}>\\n[\\s\\S]*?\\n</${tag}>$`;
	const pattern = new RegExp(`${one}(?:\\n\\n${one})*`, "m");
	return text.replace(pattern, block(tag, `{{${placeholder}}}`));
}

export function templatedSystem(context: AgentContext): string {
	let text = systemText(context);
	text = text.replace(/^- mcp__.*(?:\n- mcp__.*)*$/m, "{{MCP_TOOL_SUMMARIES}}");
	text = swapBlock(text, "mcps", "MCP_SERVERS");
	text = swapBlock(text, "cwd", "CWD");
	text = swapBlock(text, "project_context", "PROJECT_CONTEXT");
	text = swapBlock(text, "harnesses", "HARNESSES");
	text = swapBlock(text, "environment", "ENVIRONMENT");
	return text;
}

const compactSchema = (tool: CapturedTool): string => JSON.stringify(tool.parameters);

function templatedDescription(tool: CapturedTool): string {
	return tool.description
		.replace(/^Host: .*\n^Host notes: .*$/m, "{{HOST_PROBE}}")
		.replace(/^(Skills, as `path: description`:\n)[\s\S]*$/m, "$1{{SKILLS_LIST}}");
}

/** A code fence longer than any backtick run in `text`. */
function fenced(text: string, language: string): string {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(longest + 1);
	return `${fence}${language}\n${text}\n${fence}`;
}

export function renderFinal(context: AgentContext): string {
	const native = context.tools.filter((tool) => !isMcpTool(tool.name));
	const hasMcp = context.tools.some((tool) => isMcpTool(tool.name));
	const tools = native
		.map(
			(tool) =>
				`### ${tool.name}\n\n${fenced(templatedDescription(tool), "text")}\n\nSchema: \`${compactSchema(tool)}\``,
		)
		.join("\n\n");
	const title = context.kind === "main" ? "Main session" : `Subagent: ${context.role ?? "general (no role)"}`;
	return (
		[
			`<!-- Generated by \`${REGENERATE_COMMAND}\`; do not edit. Placeholders: [README.md](README.md). -->`,
			`# ${title}: final prompt`,
			`## System prompt\n\n${fenced(templatedSystem(context), "text")}`,
			`## Tools\n\n${tools}${hasMcp ? "\n\n### {{MCP_TOOLS}}" : ""}`,
		].join("\n\n") + "\n"
	);
}

export function renderFinalIndex(): string {
	const agents = AGENTS.map((agent) => `- [\`${agent.name}.md\`](${agent.name}.md): ${agent.about}`).join("\n");
	const placeholders = PLACEHOLDERS.map(
		(item) => `| \`{{${item.name}}}\` | ${item.stands} | ${item.renderedBy} |`,
	).join("\n");
	return `<!-- Generated by \`${REGENERATE_COMMAND}\`; do not edit. -->
# Final agent prompts

The system prompt and tool declarations each agent receives with its first model request, captured from a real session on a scripted model. Text that varies by machine, user, session or configuration is shown as a \`{{PLACEHOLDER}}\`; everything else is the exact text the model reads. Regenerate with \`${REGENERATE_COMMAND}\` (a test fails when these files are stale). The unreplaced captures are written to \`.octocode/agent/tmp/agent-prompts/\`.

${agents}

## Placeholders

| Placeholder | Stands for | Rendered by |
| --- | --- | --- |
${placeholders}
`;
}

/** The file name and content of every file under `final/`. */
export function finalFiles(contexts: AgentContext[]): Map<string, string> {
	const files = new Map<string, string>([["README.md", renderFinalIndex()]]);
	for (const context of contexts) files.set(`${context.name}.md`, renderFinal(context));
	return files;
}
