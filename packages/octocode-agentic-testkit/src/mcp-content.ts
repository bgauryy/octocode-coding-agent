import { vi, type Mock } from "vitest";
import { RPC_ERROR, RpcFailure, type Rpc } from "./mcp-rpc.ts";

/** A text resource the mock serves on `resources/list` and `resources/read`. */
export interface ResourceDef {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
	text: string;
}

export interface PromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

/** One message of a prompt; a string `content` is sent as a text block. */
export interface PromptMessage {
	role: "user" | "assistant";
	content: string | { type: string; [k: string]: unknown };
}

/** A prompt the mock serves on `prompts/list` and `prompts/get`. */
export interface PromptDef {
	name: string;
	description?: string;
	arguments?: PromptArgument[];
	/** Fixed messages, or messages built from the arguments of the `prompts/get` call. */
	messages: PromptMessage[] | ((args: Record<string, string>) => PromptMessage[]);
}

/** Called with the URI on each `resources/read`; returns the text sent (sync or async). */
export type ResourceMock = Mock<(uri: string) => string | Promise<string>>;

/** Called with the arguments on each `prompts/get`; returns the messages sent (sync or async). */
export type PromptMock = Mock<(args: Record<string, string>) => PromptMessage[] | Promise<PromptMessage[]>>;

/** The resources and prompts half of a mock server. */
export interface ContentServer {
	/** The `initialize` capabilities for what is configured. */
	capabilities: Record<string, object>;
	/** The result of a `resources/*` or `prompts/*` request, or undefined for any other method. */
	handle(rpc: Rpc): Promise<unknown> | undefined;
	resource(uri: string): ResourceMock;
	prompt(name: string): PromptMock;
}

function byKey<T>(server: string, kind: string, items: readonly T[], key: (t: T) => string): Map<string, T> {
	const out = new Map<string, T>();
	for (const item of items) {
		if (out.has(key(item))) throw new Error(`mockMcp ${server}: duplicate ${kind} ${key(item)}`);
		out.set(key(item), item);
	}
	return out;
}

const param = (rpc: Rpc, name: string): string => {
	const v = rpc.params?.[name];
	if (typeof v !== "string")
		throw new RpcFailure(RPC_ERROR.invalidParams, `${rpc.method}: params.${name} must be a string`);
	return v;
};

const promptArgs = (rpc: Rpc, def: PromptDef): Record<string, string> => {
	const raw = rpc.params?.arguments ?? {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new RpcFailure(RPC_ERROR.invalidParams, `prompts/get: arguments must be an object`);
	const args = raw as Record<string, unknown>;
	for (const [k, v] of Object.entries(args))
		if (typeof v !== "string")
			throw new RpcFailure(RPC_ERROR.invalidParams, `prompts/get: argument "${k}" must be a string`);
	for (const a of def.arguments ?? [])
		if (a.required && !Object.hasOwn(args, a.name))
			throw new RpcFailure(RPC_ERROR.invalidParams, `prompts/get ${def.name}: missing required argument "${a.name}"`);
	return args as Record<string, string>;
};

export function contentServer(
	server: string,
	resources: readonly ResourceDef[] | undefined,
	prompts: readonly PromptDef[] | undefined,
): ContentServer {
	const resourceDefs = byKey(server, "resource", resources ?? [], (r) => r.uri);
	const promptDefs = byKey(server, "prompt", prompts ?? [], (p) => p.name);
	const readers = new Map<string, ResourceMock>(
		[...resourceDefs.values()].map((r) => [r.uri, vi.fn((_uri: string): string | Promise<string> => r.text)]),
	);
	const getters = new Map<string, PromptMock>(
		[...promptDefs.values()].map((p) => [
			p.name,
			vi.fn((args: Record<string, string>): PromptMessage[] | Promise<PromptMessage[]> =>
				typeof p.messages === "function" ? p.messages(args) : p.messages,
			),
		]),
	);
	const capabilities: Record<string, object> = {};
	if (resources) capabilities.resources = {};
	if (prompts) capabilities.prompts = {};

	const read = async (rpc: Rpc): Promise<unknown> => {
		const uri = param(rpc, "uri");
		const def = resourceDefs.get(uri);
		if (!def) throw new RpcFailure(RPC_ERROR.resourceNotFound, `resource not found: ${uri}`);
		const text = await readers.get(uri)!(uri);
		return { contents: [{ uri, ...(def.mimeType ? { mimeType: def.mimeType } : {}), text }] };
	};
	const get = async (rpc: Rpc): Promise<unknown> => {
		const name = param(rpc, "name");
		const def = promptDefs.get(name);
		if (!def) throw new RpcFailure(RPC_ERROR.invalidParams, `unknown prompt ${name}`);
		const messages = await getters.get(name)!(promptArgs(rpc, def));
		return {
			...(def.description ? { description: def.description } : {}),
			messages: messages.map((m) => ({
				role: m.role,
				content: typeof m.content === "string" ? { type: "text", text: m.content } : m.content,
			})),
		};
	};

	return {
		capabilities,
		handle(rpc) {
			if (resources && rpc.method === "resources/list")
				return Promise.resolve({
					resources: [...resourceDefs.values()].map(({ text: _text, ...listed }) => listed),
				});
			if (resources && rpc.method === "resources/read") return read(rpc);
			if (prompts && rpc.method === "prompts/list")
				return Promise.resolve({
					prompts: [...promptDefs.values()].map(({ messages: _messages, ...listed }) => listed),
				});
			if (prompts && rpc.method === "prompts/get") return get(rpc);
			return undefined;
		},
		resource(uri) {
			const m = readers.get(uri);
			if (!m) throw new Error(`mockMcp ${server}: no resource ${uri}`);
			return m;
		},
		prompt(name) {
			const m = getters.get(name);
			if (!m) throw new Error(`mockMcp ${server}: no prompt ${name}`);
			return m;
		},
	};
}
