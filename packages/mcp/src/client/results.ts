import type { CallToolResult, Resource } from "../protocol/content.ts";
import { isObject, JSON_RPC_ERROR_CODES, McpError } from "../protocol/jsonrpc.ts";
import type { InitializeResult, ReadResourceResult, ResourceTemplate } from "../protocol/types.ts";
import type { McpRequestOptions } from "./types.ts";

const MAX_LIST_PAGES = 1_000;

/** A list item check, applied to each entry of a paginated result. */
type ListItemCheck = (item: Record<string, unknown>) => boolean;

/** One page of a paginated list, already validated. */
type ListPage = { items: Record<string, unknown>[]; nextCursor?: string };

/** Sends one list request; `McpClient.request` bound to the client. */
export type ListRequest = (
	method: string,
	params: { cursor: string } | undefined,
	options: McpRequestOptions,
) => Promise<unknown>;

export function validateInitializeResult(value: unknown): InitializeResult {
	if (
		!isObject(value) ||
		typeof value.protocolVersion !== "string" ||
		!isObject(value.capabilities) ||
		!isObject(value.serverInfo) ||
		typeof value.serverInfo.name !== "string" ||
		typeof value.serverInfo.version !== "string" ||
		(value.instructions !== undefined && typeof value.instructions !== "string")
	) {
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP initialize result");
	}
	return value as unknown as InitializeResult;
}

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
// `name` is required by the spec, but some servers omit it; the URI stands in.
export const isResource = (resource: Record<string, unknown>) =>
	typeof resource.uri === "string" && (resource.name === undefined || typeof resource.name === "string");
export const isResourceTemplate = (template: Record<string, unknown>) =>
	typeof template.uriTemplate === "string" && (template.name === undefined || typeof template.name === "string");

export function toResource(item: Record<string, unknown>): Resource {
	return { ...item, name: item.name ?? item.uri } as Resource;
}

export function toResourceTemplate(item: Record<string, unknown>): ResourceTemplate {
	return { ...item, name: item.name ?? item.uriTemplate } as ResourceTemplate;
}

export function pageCursor(page: { nextCursor?: string }): { nextCursor?: string } {
	return page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor };
}

export function validateReadResourceResult(value: unknown): ReadResourceResult {
	if (!isObject(value) || !Array.isArray(value.contents)) throw invalid("Invalid MCP resources/read result");
	for (const contents of value.contents) {
		if (
			!isObject(contents) ||
			typeof contents.uri !== "string" ||
			(typeof contents.text !== "string" && typeof contents.blob !== "string")
		) {
			throw invalid("Invalid contents in MCP resources/read result");
		}
	}
	return value as unknown as ReadResourceResult;
}

/**
 * `content` is required by the spec, but servers that only return `structuredContent` omit it (the SDK defaults it too).
 * `structuredContent` may be any JSON value, as MCP 2026-07-28 allows.
 */
export function validateCallToolResult(value: unknown): CallToolResult {
	if (!isObject(value) || (value.content !== undefined && !Array.isArray(value.content))) {
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP tools/call result");
	}
	return (value.content === undefined ? { ...value, content: [] } : value) as unknown as CallToolResult;
}

/** One page of a paginated list method, starting at `cursor`. */
export async function listPage(
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
		if (page.nextCursor === undefined) return items;
		if (cursors.has(page.nextCursor)) throw new Error(`MCP ${method} returned duplicate cursor: ${page.nextCursor}`);
		cursors.add(page.nextCursor);
		cursor = page.nextCursor;
	}
	throw new Error(`MCP ${method} exceeded ${MAX_LIST_PAGES} pages`);
}
