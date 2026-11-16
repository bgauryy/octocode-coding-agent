import type { CallToolResult, ContentBlock } from "../protocol/content.ts";
import { isObject, JSON_RPC_ERROR_CODES, McpError } from "../protocol/jsonrpc.ts";
import type { Tool } from "../protocol/types.ts";
import type { McpRequestOptions } from "./types.ts";

const MAX_LIST_PAGES = 1_000;
const MAX_LIST_ITEMS = 10_000;

/** A list item check, applied to each entry of a paginated result. */
export type ListItemCheck = (item: Record<string, unknown>) => boolean;

/** One page of a paginated list, already validated. */
type ListPage = { items: Record<string, unknown>[]; nextCursor?: string };

/** Sends one list request; `McpClient.request` bound to the client. */
export type ListRequest = (
	method: string,
	params: { cursor: string } | undefined,
	options: McpRequestOptions,
) => Promise<unknown>;

function invalid(message: string): McpError {
	return new McpError(JSON_RPC_ERROR_CODES.invalidRequest, message);
}

/** One page of a paginated list: the items under `key`, each checked by `isItem`. */
function validateListPage(
	method: string,
	key: string,
	value: unknown,
	isItem: (item: Record<string, unknown>) => boolean,
): { items: Record<string, unknown>[]; nextCursor?: string } {
	const items = isObject(value) ? value[key] : undefined;
	if (!isObject(value) || !Array.isArray(items)) throw invalid(`Invalid MCP ${method} result`);
	for (const item of items) {
		if (!isObject(item) || !isItem(item)) throw invalid(`Invalid entry in MCP ${method} result`);
	}
	// Some servers end pagination with `null` or `""` instead of omitting the cursor.
	const nextCursor = value.nextCursor === null || value.nextCursor === "" ? undefined : value.nextCursor;
	if (nextCursor !== undefined && typeof nextCursor !== "string") throw invalid(`Invalid MCP ${method} cursor`);
	return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

export const isTool = (tool: Record<string, unknown>) => typeof tool.name === "string" && isObject(tool.inputSchema);
/**
 * Keep only the tool contract. Of the server's annotations only `destructiveHint: true` stays, which the permission layer
 * turns into an ask (`mcp.destructive`); hints that would trust a tool more (`readOnlyHint`) and UI metadata are dropped.
 */
export function toTool(item: Record<string, unknown>): Tool {
	return {
		name: item.name as string,
		inputSchema: item.inputSchema as Record<string, unknown>,
		...(typeof item.title === "string" ? { title: item.title } : {}),
		...(typeof item.description === "string" ? { description: item.description } : {}),
		...(isObject(item.outputSchema) ? { outputSchema: item.outputSchema } : {}),
		...(isObject(item.execution) ? { execution: item.execution } : {}),
		...(isObject(item.annotations) && item.annotations.destructiveHint === true
			? { annotations: { destructiveHint: true as const } }
			: {}),
	};
}

/**
 * `content` is required by the spec, but servers that only return `structuredContent` omit it (the SDK defaults it too).
 * `structuredContent` may be any JSON value, as MCP 2026-07-28 allows.
 */
export function validateCallToolResult(value: unknown): CallToolResult {
	if (!isObject(value) || (value.content !== undefined && !Array.isArray(value.content))) {
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP tools/call result");
	}
	return {
		content: (value.content ?? []).map(contentBlock),
		...(value.structuredContent !== undefined ? { structuredContent: value.structuredContent } : {}),
		...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
	};
}

const optionalString = (value: unknown): value is string | undefined =>
	value === undefined || typeof value === "string";

const decodedBytes = (base64: string): number => {
	const data = base64.replace(/\s/g, "");
	return Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
};

/**
 * An embedded resource as content: its text after a line naming its URI and type, an image blob as an image, any
 * other blob as a line naming its URI, type and size (base64 is not readable text).
 */
export function embeddedResource(resource: unknown): ContentBlock {
	if (!isObject(resource) || typeof resource.uri !== "string" || !optionalString(resource.mimeType))
		throw invalid("Invalid MCP tool content");
	const { uri, mimeType } = resource;
	const label = `[resource ${uri}${mimeType ? ` (${mimeType})` : ""}]`;
	if (typeof resource.text === "string") return { type: "text", text: `${label}\n${resource.text}` };
	if (typeof resource.blob !== "string") throw invalid("Invalid MCP tool content");
	if (mimeType && /^image\//i.test(mimeType)) return { type: "image", data: resource.blob, mimeType };
	return {
		type: "text",
		text: `[resource ${uri} (${mimeType ?? "unknown type"}, ${decodedBytes(resource.blob)} bytes of binary data, not shown)]`,
	};
}

/** A link to a resource the server can read: its URI, name and what the server says about it, one per line. */
function resourceLink(value: Record<string, unknown>): ContentBlock {
	const { uri, name, title, description, mimeType, size } = value;
	if (
		typeof uri !== "string" ||
		typeof name !== "string" ||
		!optionalString(title) ||
		!optionalString(description) ||
		!optionalString(mimeType) ||
		(size !== undefined && typeof size !== "number")
	)
		throw invalid("Invalid MCP tool content");
	const lines = [
		`[resource link ${uri}]`,
		`name: ${name}`,
		...(title ? [`title: ${title}`] : []),
		...(description ? [`description: ${description}`] : []),
		...(mimeType ? [`mimeType: ${mimeType}`] : []),
		...(size !== undefined ? [`size: ${size} bytes`] : []),
	];
	return { type: "text", text: lines.join("\n") };
}

/**
 * Project supported content fields so server annotations cannot affect rendering or trust. Embedded resources and
 * resource links become text or image blocks (see {@link embeddedResource}, {@link resourceLink}).
 */
export function contentBlock(value: unknown): ContentBlock {
	if (!isObject(value) || typeof value.type !== "string") throw invalid("Invalid MCP tool content");
	if (value.type === "text" && typeof value.text === "string") return { type: "text", text: value.text };
	if (
		(value.type === "image" || value.type === "audio") &&
		typeof value.data === "string" &&
		typeof value.mimeType === "string"
	)
		return { type: value.type, data: value.data, mimeType: value.mimeType };
	if (value.type === "resource") return embeddedResource(value.resource);
	if (value.type === "resource_link") return resourceLink(value);
	if (["text", "image", "audio"].includes(value.type)) throw invalid("Invalid MCP tool content");
	return { type: "text", text: `[unsupported MCP content ${value.type}]` };
}

/** One page of a paginated list method, starting at `cursor`. */
async function listPage(
	request: ListRequest,
	method: string,
	key: string,
	isItem: ListItemCheck,
	cursor: string | undefined,
	options: McpRequestOptions,
): Promise<ListPage> {
	return validateListPage(
		method,
		key,
		await request(method, cursor === undefined ? undefined : { cursor }, options),
		isItem,
	);
}

/** Every item of a paginated list method. */
export async function listAll(
	request: ListRequest,
	method: string,
	key: string,
	isItem: ListItemCheck,
	options: McpRequestOptions,
): Promise<Record<string, unknown>[]> {
	const items: Record<string, unknown>[] = [];
	const cursors = new Set<string>();
	let cursor: string | undefined;
	for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber++) {
		const page = await listPage(request, method, key, isItem, cursor, options);
		items.push(...page.items);
		if (items.length > MAX_LIST_ITEMS) throw new Error(`MCP ${method} exceeded ${MAX_LIST_ITEMS} items`);
		if (page.nextCursor === undefined) return items;
		if (cursors.has(page.nextCursor)) throw new Error(`MCP ${method} returned duplicate cursor: ${page.nextCursor}`);
		cursors.add(page.nextCursor);
		cursor = page.nextCursor;
	}
	throw new Error(`MCP ${method} exceeded ${MAX_LIST_PAGES} pages`);
}
