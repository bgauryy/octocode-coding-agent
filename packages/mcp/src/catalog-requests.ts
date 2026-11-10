/**
 * Resources and prompts of this session's servers, for the `mcp` tool (`resources`, `read`) and `/mcp` (`resources`,
 * `prompts`, `prompt`). Every request goes to the server's current connection and is answered from it; nothing is
 * cached or subscribed (MCP 2026-07-28 replaces `resources/subscribe`). Server text is shown with control and invisible
 * characters escaped (`sanitizeJson`), like tool results.
 */

import type { McpClient, McpPromptArgument } from "./client/index.ts";
import { isEnabled } from "./server.ts";
import { sanitizeJson } from "./sanitize.ts";
import type { McpExtensionState } from "./state.ts";
import type { ContentBlock } from "./client/protocol/content.ts";

const visible = (text: string): string => sanitizeJson(text) as string;

/** The connected client of a server in this session, or an error naming why it has none. */
async function clientOf(state: McpExtensionState, name: string, signal?: AbortSignal) {
	const server = state.findServer(name);
	if (!server) {
		const known = state.servers.map((candidate) => candidate.entry.name).join(", ") || "none";
		throw new Error(`No MCP server "${name}" in this session. Servers: ${known}.`);
	}
	if (!isEnabled(server)) throw new Error(`MCP server "${name}" is disabled in its configuration.`);
	if (server.unselected) throw new Error(`MCP server "${name}" is not selected for this session.`);
	const connection = server.connection;
	if (!connection) throw new Error(`MCP server "${name}" is still starting.`);
	const client: McpClient = await connection.getClient();
	return { client, options: { signal, timeoutMs: connection.timeoutMs } };
}

const described = (item: { title?: string; description?: string; mimeType?: string }): string => {
	const about = (item.title ?? item.description)?.replace(/\s+/g, " ").trim();
	return `${about ? `: ${about}` : ""}${item.mimeType ? ` (${item.mimeType})` : ""}`;
};

/** A server's resources and resource templates, one per line. */
export async function resourceListing(state: McpExtensionState, name: string, signal?: AbortSignal): Promise<string> {
	const { client, options } = await clientOf(state, name, signal);
	if (!client.serverCapabilities?.resources) return `MCP server "${name}" offers no resources.`;
	const [resources, templates] = [await client.listResources(options), await client.listResourceTemplates(options)];
	const lines = [
		...resources.map((resource) => `- ${resource.uri} ${resource.name}${described(resource)}`),
		...templates.map((template) => `- template ${template.uriTemplate} ${template.name}${described(template)}`),
	];
	return visible(lines.length > 0 ? lines.join("\n") : `MCP server "${name}" lists no resources.`);
}

/** One resource's contents, as tool content. */
export async function readServerResource(
	state: McpExtensionState,
	name: string,
	uri: string,
	signal?: AbortSignal,
): Promise<ContentBlock[]> {
	const { client, options } = await clientOf(state, name, signal);
	return client.readResource(uri, options);
}

const promptLine = (prompt: { name: string; description?: string; arguments?: McpPromptArgument[] }): string => {
	const args = (prompt.arguments ?? []).map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(" ");
	const about = prompt.description?.replace(/\s+/g, " ").trim();
	return `- ${prompt.name}${args ? ` ${args}` : ""}${about ? `: ${about}` : ""}`;
};

/** A server's prompts with their arguments (`<required>`, `[optional]`), one per line. */
export async function promptListing(state: McpExtensionState, name: string): Promise<string> {
	const { client, options } = await clientOf(state, name);
	if (!client.serverCapabilities?.prompts) return `MCP server "${name}" offers no prompts.`;
	const prompts = await client.listPrompts(options);
	return visible(prompts.length > 0 ? prompts.map(promptLine).join("\n") : `MCP server "${name}" lists no prompts.`);
}

/**
 * The `prompts/get` arguments for the words typed after a prompt's name. A `key=value` word sets that argument; the
 * other words fill the prompt's declared arguments in order, skipping names already set, and words past the last free
 * argument are an error. The map has no prototype, so an argument named `__proto__` is a plain key.
 */
export function promptArguments(
	declared: readonly McpPromptArgument[],
	words: readonly string[],
): Record<string, string> {
	const args: Record<string, string> = Object.create(null);
	const positional: string[] = [];
	for (const word of words) {
		const equals = word.indexOf("=");
		if (equals > 0) args[word.slice(0, equals)] = word.slice(equals + 1);
		else positional.push(word);
	}
	const free = declared.map((arg) => arg.name).filter((name) => !Object.hasOwn(args, name));
	if (positional.length > free.length)
		throw new Error(`Too many arguments: the prompt takes ${declared.map((arg) => arg.name).join(", ") || "none"}.`);
	positional.forEach((value, index) => {
		args[free[index]] = value;
	});
	const missing = declared.filter((arg) => arg.required && !Object.hasOwn(args, arg.name)).map((arg) => arg.name);
	if (missing.length > 0)
		throw new Error(`Missing required argument${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
	return args;
}

/** A prompt's messages as one text: each message's text or resource text, in order. */
export async function promptText(
	state: McpExtensionState,
	server: string,
	prompt: string,
	words: readonly string[],
): Promise<string> {
	const { client, options } = await clientOf(state, server);
	if (!client.serverCapabilities?.prompts) throw new Error(`MCP server "${server}" offers no prompts.`);
	const declared = (await client.listPrompts(options)).find((candidate) => candidate.name === prompt);
	if (!declared) throw new Error(`No prompt "${prompt}" on MCP server "${server}".`);
	const messages = await client.getPrompt(prompt, promptArguments(declared.arguments ?? [], words), options);
	const parts = messages.map((message) =>
		message.content.type === "text" ? message.content.text : `[${message.content.type} omitted]`,
	);
	return visible(parts.join("\n\n"));
}
