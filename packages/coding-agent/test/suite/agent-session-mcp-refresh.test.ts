import "../mcp-host.ts";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage, getCurrentTools } from "@octocodeai/octocode-ai";
import type { SystemMessage } from "@octocodeai/octocode-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "../../../mcp/src/client/index.ts";
import { createInMemoryTransportPair } from "../../../mcp/src/client/testing/index.ts";
import type { McpServerEntry } from "../../../mcp/src/config.ts";
import { createMcpExtension } from "../../../mcp/src/index.ts";
import { MCP_STATUS_SECTION, MCPS_SECTION } from "../../../mcp/src/section.ts";
import type { ExtensionAPI } from "../../src/core/features/types.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, createTestUiContext, type Harness, getToolResult } from "./harness.ts";

/**
 * B431 option A (T5-T11, M1-M7): the `mcps` block is renewed only when a connected server's contract changes (its
 * instructions, or a described tool's description or schemas), as one appended patch of the section that rides with the
 * tool changes of the same request; a reconnect, a reload of the same catalog or a withdrawal appends no `mcps` text.
 * Each case annotates the characters the request appended to the prompt.
 */

interface ServerState {
	instructions: string;
	tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

const SEARCH = {
	name: "search",
	description: "Search the docs.",
	inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
const FAIL = { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } };
const OLD_RULE = "Old rule: always pass query.";
const NEW_RULE = "New rule: query must be lower-case.";

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

const systemMessages = (harness: Harness, from = 0) =>
	harness.session.messages.slice(from).filter((message): message is SystemMessage => message.role === "system");

/** Characters the system updates since `from` add to the prompt: their text and every section they set. */
const appendedChars = (updates: SystemMessage[]) =>
	updates.reduce(
		(sum, update) =>
			sum +
			(typeof update.content === "string" ? update.content.length : 0) +
			Object.values(update.sections ?? {}).reduce((total, text) => total + (text?.length ?? 0), 0),
		0,
	);

const mcpsPatches = (updates: SystemMessage[]) =>
	updates.flatMap((update) => (update.sections?.[MCPS_SECTION] ? [update.sections[MCPS_SECTION]] : []));

/** The newest copy of the `mcps` section in the messages. */
const newestMcps = (messages: Parameters<typeof getCurrentSystemMessage>[0]) =>
	getCurrentSystemMessage(messages)?.sections?.[MCPS_SECTION] ?? undefined;

describe("AgentSession MCP contract refresh", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		server: ServerState,
		options: { sessionManager?: SessionManager; late?: ServerState; compactionSummary?: string } = {},
	) {
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
					// These cases pin the thin-declaration presentation; `declared`, the default, is covered in
					// test/octocode/mcp-instructions-delta.test.ts.
					presentation: "compact",
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
	}

	const fresh = (): ServerState => ({ instructions: OLD_RULE, tools: [SEARCH, FAIL] });

	it("M1: a reconnect and a reload of the same catalog append nothing", async ({ annotate }) => {
		const server = fresh();
		const { reconnect, listChanged, turn } = await setup(server);
		const first = await turn("start");
		expect(newestMcps(first)).toContain(OLD_RULE);
		await reconnect();
		const afterReconnect = await turn("after reconnect");
		server.tools = server.tools.map((tool) => ({ ...tool }));
		await listChanged();
		const afterReload = await turn("after reload");
		for (const updates of [afterReconnect, afterReload]) {
			expect(mcpsPatches(updates)).toEqual([]);
			expect(updates.flatMap((update) => [...(update.toolsAdded ?? []), ...(update.toolsRemoved ?? [])])).toEqual([]);
		}
		const chars = appendedChars([...afterReconnect, ...afterReload]);
		expect(chars).toBe(0);
		await annotate(
			`M1 appended chars: reconnect ${appendedChars(afterReconnect)}, reload ${appendedChars(afterReload)}`,
		);
	});

	it("M2: a changed description appends one section with it, and the tool is thin in the same request", async ({
		annotate,
	}) => {
		const server = fresh();
		const { listChanged, turn, thin } = await setup(server);
		await turn("start");
		server.tools = [{ ...SEARCH, description: "Search the docs by title." }, FAIL];
		await listChanged();
		const updates = await turn("after change");
		const patches = mcpsPatches(updates);
		expect(patches).toHaveLength(1);
		expect(patches[0]).toContain("Search the docs by title.");
		const carrier = updates.find((update) => update.sections?.[MCPS_SECTION]);
		expect(carrier?.toolsAdded?.map((tool) => tool.name)).toEqual(["mcp__docs__search"]);
		expect(thin("mcp__docs__search")).toBe(true);
		expect(appendedChars(updates)).toBe(patches[0].length);
		await annotate(`M2 appended chars: ${appendedChars(updates)} (mcps section ${patches[0].length})`);
	});

	it("M3: a changed schema appends one section with it, and a call valid only under the new schema runs", async ({
		annotate,
	}) => {
		const server = fresh();
		const { harness, calls, listChanged, turn, thin } = await setup(server);
		await turn("start");
		const objectQuery = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
		server.tools = [{ ...SEARCH, inputSchema: { ...SEARCH.inputSchema, properties: { query: objectQuery } } }, FAIL];
		await listChanged();
		const from = harness.session.messages.length;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: { text: "x" } })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search with the new schema");
		const updates = systemMessages(harness, from);
		const patches = mcpsPatches(updates);
		expect(patches).toHaveLength(1);
		expect(patches[0]).toMatch(/query: \{\s*text: string;?\s*\}/);
		expect(thin("mcp__docs__search")).toBe(true);
		expect(getToolResult(harness, "mcp__docs__search").isError).toBe(false);
		expect(calls).toEqual(['search:{"query":{"text":"x"}}']);
		await annotate(`M3 appended chars: ${appendedChars(updates)}`);
	});

	it("M4: changed instructions append one section whose newest copy has them, with no tool change", async ({
		annotate,
	}) => {
		const server = fresh();
		const { harness, reconnect, turn, thin } = await setup(server);
		await turn("start");
		server.instructions = NEW_RULE;
		await reconnect();
		const updates = await turn("after change");
		const patches = mcpsPatches(updates);
		expect(patches).toHaveLength(1);
		expect(patches[0]).toContain(NEW_RULE);
		expect(patches[0]).not.toContain(OLD_RULE);
		expect(newestMcps(harness.session.messages)).toBe(patches[0]);
		expect(updates.flatMap((update) => [...(update.toolsAdded ?? []), ...(update.toolsRemoved ?? [])])).toEqual([]);
		expect(thin("mcp__docs__search")).toBe(true);
		await annotate(`M4 appended chars: ${appendedChars(updates)}`);
	});

	it("M5: a withdrawn tool is removed with a status line, no section re-send, and its calls are refused", async ({
		annotate,
	}) => {
		const server = fresh();
		const { harness, calls, callable, listChanged, turn } = await setup(server);
		const block = newestMcps(await turn("start"));
		server.tools = [SEARCH];
		await listChanged();
		await vi.waitFor(() => expect(callable()).not.toContain("mcp__docs__fail"));
		const from = harness.session.messages.length;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__fail", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("call fail");
		const updates = systemMessages(harness, from);
		expect(mcpsPatches(updates)).toEqual([]);
		expect(updates.flatMap((update) => update.toolsRemoved ?? []).map((tool) => tool.name)).toEqual([
			"mcp__docs__fail",
		]);
		expect(updates.find((update) => update.toolsRemoved)?.sections?.[MCP_STATUS_SECTION]).toContain(
			"- docs: connected; not declared: fail",
		);
		expect(newestMcps(harness.session.messages)).toBe(block);
		expect(getToolResult(harness, "mcp__docs__fail").isError).toBe(true);
		expect(calls).toEqual([]);
		await annotate(`M5 appended chars: ${appendedChars(updates)}`);
	});

	it("M6: a server that connects late gets its block in the request that declares its tools", async ({ annotate }) => {
		const { harness, callable, turn } = await setup(fresh(), {
			late: { instructions: "Late rules.", tools: [{ ...SEARCH, description: "Search late docs." }] },
		});
		const first = newestMcps(await turn("start"));
		expect(first).toContain("Not connected yet");
		await vi.waitFor(() => expect(callable()).toContain("mcp__late__search"));
		const updates = await turn("after connect");
		const patches = mcpsPatches(updates);
		expect(patches).toHaveLength(1);
		expect(patches[0]).toContain("Late rules.");
		const carrier = updates.find((update) => update.sections?.[MCPS_SECTION]);
		expect(carrier?.toolsAdded?.map((tool) => tool.name)).toContain("mcp__late__search");
		expect(newestMcps(harness.session.messages)).toContain(OLD_RULE);
		await annotate(`M6 appended chars: ${appendedChars(updates)}`);
	});

	it("M7: after compaction and resume the newest copy carries the changed contract, and nothing is re-sent", async ({
		annotate,
	}) => {
		const server = fresh();
		const { harness, listChanged, turn } = await setup(server);
		await turn("start");
		server.tools = [{ ...SEARCH, description: "Search the docs by title." }, FAIL];
		await listChanged();
		const changed = mcpsPatches(await turn("after change"))[0];
		expect(changed).toContain("Search the docs by title.");
		await turn("one more");
		await harness.session.compact();
		const compacted = harness.sessionManager.buildSessionContext().messages;
		expect(compacted.some((message) => message.role === "compactionSummary")).toBe(true);
		expect(newestMcps(compacted)).toBe(changed);
		const afterCompaction = await turn("after compaction");
		expect(mcpsPatches(afterCompaction)).toEqual([]);

		// Resumed with the same catalog: the transcript already has it.
		const resumed = await setup(server, { sessionManager: harness.sessionManager });
		const afterResume = await resumed.turn("after resume");
		expect(mcpsPatches(afterResume)).toEqual([]);
		expect(newestMcps(resumed.harness.session.messages)).toBe(changed);

		// Resumed after the server changed again while the session was closed: one patch with the newest text.
		server.instructions = NEW_RULE;
		const reopened = await setup(server, { sessionManager: resumed.harness.sessionManager });
		const afterReopen = await reopened.turn("after reopen");
		const patches = mcpsPatches(afterReopen);
		expect(patches).toHaveLength(1);
		expect(patches[0]).toContain(NEW_RULE);
		expect(newestMcps(reopened.harness.session.messages)).toBe(patches[0]);
		await annotate(
			`M7 appended chars: after compaction ${appendedChars(afterCompaction)}, after resume ${appendedChars(afterResume)}, after a change while closed ${appendedChars(afterReopen)}`,
		);
	});
});
