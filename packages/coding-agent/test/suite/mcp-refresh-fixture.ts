import { fauxAssistantMessage, getCurrentSystemMessage, getCurrentTools } from "@octocodeai/octocode-ai";
import type { FauxModelDefinition, SystemMessage } from "@octocodeai/octocode-ai/compat";
import { expect, vi } from "vitest";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "../../../mcp/src/client/index.ts";
import { createInMemoryTransportPair } from "../../../mcp/src/client/testing/index.ts";
import type { McpServerEntry } from "../../../mcp/src/config.ts";
import { createMcpExtension } from "../../../mcp/src/index.ts";
import type { McpPresentationMode } from "../../../mcp/src/presentation/index.ts";
import { MCP_STATUS_SECTION, MCPS_SECTION } from "../../../mcp/src/section.ts";
import type { ExtensionAPI } from "../../src/core/features/types.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

/** A real AgentSession with one in-memory MCP server (`docs`) whose catalog a test edits between requests. */

export interface ServerState {
	instructions: string;
	tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> } & Record<string, unknown>>;
}

export const SEARCH = {
	name: "search",
	description: "Search the docs.",
	inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
export const FAIL = { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } };
export const OLD_RULE = "Old rule: always pass query.";
export const NEW_RULE = "New rule: query must be lower-case.";

export const fresh = (): ServerState => ({ instructions: OLD_RULE, tools: [SEARCH, FAIL] });

function createFakeServer(state: () => ServerState, calls: string[], initializeDelayMs = 0) {
	const pair = createInMemoryTransportPair();
	const respond = (request: JsonRpcRequest): unknown => {
		if (request.method === "initialize")
			return {
				protocolVersion: LATEST_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "docs", version: "1.0.0" },
				instructions: state().instructions,
			};
		if (request.method === "tools/list") return { tools: state().tools };
		if (request.method === "tools/call") {
			const params = request.params as { name: string; arguments?: unknown };
			calls.push(`${params.name}:${JSON.stringify(params.arguments ?? {})}`);
			return { content: [{ type: "text", text: "ok" }] };
		}
		return {};
	};
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const send = () => void pair.server.send({ jsonrpc: "2.0", id: message.id, result: respond(message) });
		if (message.method === "initialize" && initializeDelayMs > 0) setTimeout(send, initializeDelayMs);
		else queueMicrotask(send);
	});
	return pair;
}

export const systemMessages = (harness: Harness, from = 0) =>
	harness.session.messages.slice(from).filter((message): message is SystemMessage => message.role === "system");

/** Characters the system updates since `from` add to the prompt: their text and every section they set. */
export const appendedChars = (updates: SystemMessage[]) =>
	updates.reduce(
		(sum, update) =>
			sum +
			(typeof update.content === "string" ? update.content.length : 0) +
			Object.values(update.sections ?? {}).reduce((total, text) => total + (text?.length ?? 0), 0),
		0,
	);

export const mcpsPatches = (updates: SystemMessage[]) =>
	updates.flatMap((update) => (update.sections?.[MCPS_SECTION] ? [update.sections[MCPS_SECTION]] : []));

/** Tool names the updates add or remove. */
export const toolChanges = (updates: SystemMessage[]) =>
	updates.flatMap((update) => [
		...(update.toolsAdded ?? []).map((tool) => `+${tool.name}`),
		...(update.toolsRemoved ?? []).map((tool) => `-${tool.name}`),
	]);

/** The newest copy of the `mcps` section in the messages. */
export const newestMcps = (messages: Parameters<typeof getCurrentSystemMessage>[0]) =>
	getCurrentSystemMessage(messages)?.sections?.[MCPS_SECTION] ?? undefined;

/** The current `mcp_status` section of the messages, undefined when none applies. */
export const currentStatus = (messages: Parameters<typeof getCurrentSystemMessage>[0]) =>
	getCurrentSystemMessage(messages)?.sections?.[MCP_STATUS_SECTION] || undefined;

export interface SetupOptions {
	sessionManager?: SessionManager;
	late?: ServerState;
	compactionSummary?: string;
	presentation?: McpPresentationMode;
	/** Faux models; a second one lets a test switch models, which rebuilds the loadout. */
	models?: FauxModelDefinition[];
}

/** A `setup` bound to the test's harness list, which the caller cleans up after each test. */
export function createMcpRefreshSetup(harnesses: Harness[]) {
	return async function setup(server: ServerState, options: SetupOptions = {}) {
		const calls: string[] = [];
		const transports: ReturnType<typeof createFakeServer>[] = [];
		const entry = (name: string): McpServerEntry => ({
			name,
			config: { url: "http://unused.invalid", exposure: "direct" },
			source: "test",
		});
		const servers = [entry("docs"), ...(options.late ? [entry("late")] : [])];
		const harness = await createHarness({
			initialActiveToolNames: options.sessionManager ? undefined : [],
			compactionPolicy: { enabled: false, keepRecentTokens: 1 },
			sessionManager: options.sessionManager,
			...(options.models ? { models: options.models } : {}),
			builtinCompactionFactories: [
				(api: ExtensionAPI) => {
					api.on("session_before_compact", async ({ preparation }) => ({
						compaction: {
							summary: options.compactionSummary ?? "Looked up the docs.",
							firstKeptEntryId: preparation.firstKeptEntryId,
							tokensBefore: preparation.tokensBefore,
						},
					}));
				},
				createMcpExtension({
					loadConfig: () => ({ servers, errors: [] }),
					startupWaitMs: 10,
					// `/mcp enable|disable` change the session's servers; nothing is written to a real mcp.json.
					updateConfig: () => {},
					...(options.presentation ? { presentation: options.presentation } : {}),
					createTransport: (target) => {
						const late = target.name === "late" && options.late;
						const pair = late ? createFakeServer(() => late, calls, 300) : createFakeServer(() => server, calls);
						transports.push(pair);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		// A resumed session starts from its transcript, like `createTestSession` does.
		if (options.sessionManager)
			harness.session.agent.state.messages = options.sessionManager.buildSessionContext().messages;
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const callable = () => harness.session.getCallableToolNames();
		await vi.waitFor(() => expect(callable()).toContain("mcp__docs__search"));
		const listChanged = async () => {
			const docs = transports.filter((pair) => pair !== undefined).at(options.late ? -2 : -1)!;
			await docs.server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
			await new Promise((resolve) => setTimeout(resolve, 20));
		};
		const reconnect = async () => {
			await harness.session.prompt("/mcp reconnect docs");
			await vi.waitFor(() => expect(callable()).toContain("mcp__docs__search"));
		};
		/** Prompt once and return the system updates that request appended. */
		const turn = async (text: string) => {
			const from = harness.session.messages.length;
			harness.setResponses([fauxAssistantMessage(`reply to ${text}`)]);
			await harness.session.prompt(text);
			return systemMessages(harness, from);
		};
		const thin = (name: string) =>
			(
				getCurrentTools(harness.session.messages).find((tool) => tool.name === name)?.parameters as {
					additionalProperties?: unknown;
				}
			)?.additionalProperties === true;
		return { harness, calls, callable, listChanged, reconnect, turn, thin };
	};
}
