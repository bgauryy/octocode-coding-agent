import { isMcpTool } from "./analyze.ts";
import { AGENTS, type AgentContext } from "./capture.ts";

/** A code fence longer than any backtick run in `text`, so the text cannot close it early. */
function fenced(text: string, language = "text"): string {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(longest + 1);
	return `${fence}${language}\n${text}\n${fence}`;
}

/** The system prompt as the model reads it: the sections in order, separated by a blank line. */
export const systemText = (context: AgentContext): string =>
	context.sections.map((section) => section.text).join("\n\n");

const title = (context: AgentContext): string =>
	context.kind === "main" ? "Main session" : `Subagent: ${context.role ?? "general (no role)"}`;

export function renderSystem(context: AgentContext): string {
	return `# ${title(context)}: system prompt\n\n${fenced(systemText(context))}\n`;
}

export function renderTools(context: AgentContext): string {
	const block = (tool: AgentContext["tools"][number]): string =>
		`### ${tool.name}\n\n${fenced(tool.description)}\n\n${fenced(JSON.stringify(tool.parameters, null, 2), "json")}`;
	const native = context.tools.filter((tool) => !isMcpTool(tool.name));
	const mcp = context.tools.filter((tool) => isMcpTool(tool.name));
	const group = (heading: string, tools: typeof native): string =>
		`## ${heading}\n\n${tools.length > 0 ? tools.map(block).join("\n\n") : "None."}`;
	return `# ${title(context)}: tools\n\n${group("Native tools", native)}\n\n${group("MCP tools", mcp)}\n`;
}

export function renderMessages(context: AgentContext): string {
	const messages = context.messages
		.map((message, index) => `## ${index + 1}. ${message.role}\n\n${fenced(message.text)}`)
		.join("\n\n");
	return `# ${title(context)}: messages\n\n${messages || "None."}\n`;
}

/** The folder's `README.md`: what it is and one link per agent. */
export function renderIndex(): string {
	const agents = AGENTS.map((agent) => `- [\`${agent.name}/\`](${agent.name}/system.md): ${agent.about}`).join("\n");
	return `# Rendered agent contexts\n\nWritten by every build, and by \`yarn workspace @octocodeai/octocode-agent run generate:prompts\`; do not edit. Each folder holds the system prompt, tools and first messages one agent receives.\n\n${agents}\n`;
}
