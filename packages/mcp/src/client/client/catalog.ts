/**
 * Resources and prompts a server offers (MCP `resources/*`, `prompts/*`): the fields the host shows, projected like tool
 * listings so server annotations cannot affect rendering or trust. Subscriptions are not supported: MCP 2026-07-28
 * replaces `resources/subscribe` with `subscriptions/listen`.
 */

import type { ContentBlock } from "../protocol/content.ts";
import { isObject, JSON_RPC_ERROR_CODES, McpError } from "../protocol/jsonrpc.ts";
import { contentBlock, embeddedResource, listAll, type ListItemCheck, type ListRequest } from "./results.ts";
import type { McpRequestOptions } from "./types.ts";

export interface McpResource {
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
}

export interface McpResourceTemplate {
	uriTemplate: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
}

export interface McpPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

export interface McpPrompt {
	name: string;
	title?: string;
	description?: string;
	arguments?: McpPromptArgument[];
}

export interface McpPromptMessage {
	role: "user" | "assistant";
	content: ContentBlock;
}

const text = (item: Record<string, unknown>, key: string) =>
	typeof item[key] === "string" ? { [key]: item[key] } : {};
const described = (item: Record<string, unknown>) => ({
	...text(item, "title"),
	...text(item, "description"),
	...text(item, "mimeType"),
});

const isResource: ListItemCheck = (item) => typeof item.uri === "string" && typeof item.name === "string";
const isTemplate: ListItemCheck = (item) => typeof item.uriTemplate === "string" && typeof item.name === "string";
const isPrompt: ListItemCheck = (item) =>
	typeof item.name === "string" && (item.arguments === undefined || Array.isArray(item.arguments));

export async function listResources(request: ListRequest, options: McpRequestOptions): Promise<McpResource[]> {
	const items = await listAll(request, "resources/list", "resources", isResource, options);
	return items.map((item) => ({ uri: item.uri as string, name: item.name as string, ...described(item) }));
}

export async function listResourceTemplates(
	request: ListRequest,
	options: McpRequestOptions,
): Promise<McpResourceTemplate[]> {
	const items = await listAll(request, "resources/templates/list", "resourceTemplates", isTemplate, options);
	return items.map((item) => ({
		uriTemplate: item.uriTemplate as string,
		name: item.name as string,
		...described(item),
	}));
}

export async function listPrompts(request: ListRequest, options: McpRequestOptions): Promise<McpPrompt[]> {
	const items = await listAll(request, "prompts/list", "prompts", isPrompt, options);
	return items.map((item) => {
		const args = ((item.arguments as unknown[] | undefined) ?? []).filter(
			(arg): arg is Record<string, unknown> => isObject(arg) && typeof arg.name === "string",
		);
		return {
			name: item.name as string,
			...text(item, "title"),
			...text(item, "description"),
			...(args.length > 0
				? {
						arguments: args.map((arg) => ({
							name: arg.name as string,
							...text(arg, "description"),
							...(arg.required === true ? { required: true } : {}),
						})),
					}
				: {}),
		};
	});
}

/** A `resources/read` result as content: each item's text after a line naming its URI, an image blob as an image. */
export function readResourceContent(value: unknown): ContentBlock[] {
	if (!isObject(value) || !Array.isArray(value.contents))
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP resources/read result");
	return value.contents.map(embeddedResource);
}

/** A `prompts/get` result: its messages, each content projected like tool content. */
export function promptMessages(value: unknown): McpPromptMessage[] {
	if (!isObject(value) || !Array.isArray(value.messages))
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP prompts/get result");
	return value.messages.map((message: unknown) => {
		if (!isObject(message) || (message.role !== "user" && message.role !== "assistant"))
			throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid message in MCP prompts/get result");
		return { role: message.role, content: contentBlock(message.content) };
	});
}
