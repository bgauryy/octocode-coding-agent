import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@octocodeai/octocode-ai";
import type { SystemMessage } from "@octocodeai/octocode-ai/compat";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "../../../mcp/src/client/index.ts";
import { createInMemoryTransportPair } from "../../../mcp/src/client/testing/index.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../src/core/event-bus.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import type { McpExposure, McpServerEntry } from "../../../mcp/src/config.ts";
import type { McpPresentationMode } from "../../../mcp/src/presentation/index.ts";
import { createMcpExtension } from "../../../mcp/src/index.ts";
import { MCP_CONTRACT_SECTION_PREFIX, MCP_STATUS_SECTION } from "../../../mcp/src/section.ts";
import { getMcpSessionStatus } from "../../../mcp/src/status.ts";
import { createMcpToolName } from "../../../mcp/src/tool-names.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import {
	createHarness,
	createTestUiContext,
	getAssistantTexts,
	getMessageText,
	type Harness,
	getToolResult as toolResult,
} from "./harness.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const SERVER_TOOLS = [
	{
		name: "search",
		description: "Search the docs.",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		outputSchema: {
			type: "object",
			properties: { hits: { type: "array", items: { type: "string" } } },
			required: ["hits"],
		},
	},
	{
		name: "fail",
		description: "Always fails.",
		inputSchema: { type: "object", properties: {} },
		annotations: { title: "Fail", destructiveHint: true, readOnlyHint: false, idempotentHint: "yes" },
	},
	{ name: "shot", description: "Returns an image.", inputSchema: { type: "object", properties: {} } },
];

/**
 * Minimal MCP server over an in-memory transport. Records the tool calls it receives.
 * `initializeDelayMs` delays the answer to `initialize`; `Infinity` never answers.
 */
function createFakeServer(
	calls: string[],
	options: {
		listTools?: () => unknown[];
		resources?: boolean;
		instructions?: string;
		initializeDelayMs?: number;
		/** Answer `initialize` with an error, so the connection fails. */
		initializeFails?: boolean;
	} = {},
) {
	const {
		listTools = () => SERVER_TOOLS,
		resources = false,
		instructions,
		initializeDelayMs = 0,
		initializeFails = false,
	} = options;
	const pair = createInMemoryTransportPair();
	const respond = (request: JsonRpcRequest): unknown => {
		switch (request.method) {
			case "initialize":
				return {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {}, ...(resources ? { resources: {} } : {}) },
					serverInfo: { name: "docs", version: "1.0.0" },
					...(instructions ? { instructions } : {}),
				};
			case "tools/list":
				return { tools: listTools() };
			case "tools/call": {
				const params = request.params as { name: string; arguments?: { query?: string } };
				calls.push(`${params.name}:${JSON.stringify(params.arguments ?? {})}`);
				if (params.name === "search") {
					const hits = [`${params.arguments?.query} guide`, `${params.arguments?.query} faq`];
					return { content: [{ type: "text", text: hits.join("\n") }], structuredContent: { hits } };
				}
				if (params.name === "shot") {
					return { content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }] };
				}
				return { content: [{ type: "text", text: "server exploded" }], isError: true };
			}
			default:
				return {};
		}
	};
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message;
		const send = () =>
			void pair.server.send(
				initializeFails && request.method === "initialize"
					? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "initialize failed" } }
					: { jsonrpc: "2.0", id: request.id, result: respond(request) },
			);
		if (request.method !== "initialize" || initializeDelayMs === 0) queueMicrotask(send);
		else if (Number.isFinite(initializeDelayMs)) setTimeout(send, initializeDelayMs);
	});
	return pair;
}

const hasToolsRemoved = (message: { role: string }) =>
	message.role === "system" && ((message as SystemMessage).toolsRemoved ?? []).length > 0;

describe("AgentSession MCP integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		exposure: McpExposure | undefined,
		listTools?: () => unknown[],
		options: {
			builtInTools?: string[];
			/** `--tools` and `--exclude-tools`. */
			allowedToolNames?: string[];
			excludedToolNames?: string[];
			/** Session to continue. */
			sessionManager?: SessionManager;
			/** Whether to wait for `mcp__docs__search` to register. Default: true. */
			waitForTools?: boolean;
			extensionFactories?: ExtensionFactory[];
			builtinCompactionFactories?: ExtensionFactory[];
			toolExposure?: Record<string, McpExposure>;
			resources?: boolean;
			description?: string;
			instructions?: string;
			/** How tools and the `mcp_contract_<server>` sections are presented. Default: the setting (`compact`). */
			presentation?: McpPresentationMode;
		} = {},
	) {
		const {
			builtInTools,
			allowedToolNames,
			excludedToolNames,
			sessionManager,
			waitForTools = true,
			extensionFactories = [],
			builtinCompactionFactories,
			toolExposure,
			resources,
			description,
			instructions,
			presentation,
			...configOptions
		} = options;
		const calls: string[] = [];
		const notifications: string[] = [];
		const saved: Array<{ enabled?: boolean; exposure?: McpExposure }> = [];
		const registrations: Array<{ name: string }> = [];
		const servers: ReturnType<typeof createFakeServer>["server"][] = [];
		const entry: McpServerEntry = {
			name: "docs",
			config: {
				url: "http://unused.invalid",
				exposure,
				...(toolExposure ? { toolExposure } : {}),
				...(description ? { description } : {}),
			},
			source: "test",
		};
		const harness = await createHarness({
			initialActiveToolNames: allowedToolNames ?? builtInTools ?? (sessionManager ? undefined : []),
			compactionPolicy: { enabled: false, keepRecentTokens: 1 },
			allowedToolNames,
			excludedToolNames,
			sessionManager,
			[builtinCompactionFactories ? "builtinCompactionFactories" : "extensionFactories"]: [
				...(builtinCompactionFactories ?? []),
				...extensionFactories,
				(api: ExtensionAPI) =>
					createMcpExtension({
						loadConfig: () => ({ servers: [entry], errors: [], ...configOptions }),
						...(presentation ? { presentation } : {}),
						updateConfig: (_entry, patch) => {
							saved.push(patch);
						},
						createTransport: () => {
							const pair = createFakeServer(calls, { listTools, resources, instructions });
							servers.push(pair.server);
							void pair.server.start();
							return pair.client;
						},
					})({
						...api,
						registerTool: (definition) => {
							registrations.push(definition);
							api.registerTool(definition);
						},
						// A connection's tools register as one batch; record each definition.
						registerTools: (definitions) => {
							registrations.push(...definitions);
							api.registerTools(definitions);
						},
					}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		// The servers connect in the background after binding; wait for the tools here.
		if (waitForTools) {
			await vi.waitFor(() =>
				expect(harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
			);
		}
		return { harness, calls, servers, notifications, saved, registrations };
	}

	function declaredToolNames(harness: Harness): string[] {
		return harness.session.messages
			.filter((message): message is SystemMessage => message.role === "system")
			.flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name));
	}

	/**
	 * The MCP prompt sections as the model currently has them: each server's contract (`mcp_contract_<server>`, a base
	 * section), then `mcp_status`; undefined when the model has none.
	 */
	function serversSection(harness: Harness): string | undefined {
		const current = new Map<string, string | null>();
		for (const message of harness.session.messages) {
			if (message.role !== "system" || !message.sections) continue;
			for (const [name, text] of Object.entries(message.sections))
				if (name === MCP_STATUS_SECTION || name.startsWith(MCP_CONTRACT_SECTION_PREFIX)) current.set(name, text);
		}
		const status = current.get(MCP_STATUS_SECTION);
		const texts = [...current].flatMap(([name, text]) => (name !== MCP_STATUS_SECTION && text ? [text] : []));
		if (status) texts.push(status);
		return texts.length ? texts.join("\n") : undefined;
	}

	function nestedToolNames(harness: Harness): string[] {
		return harness.session.getCallableToolNames();
	}

	it("configures servers through slash subcommands and publishes enabled and connection state", async () => {
		let api: ExtensionAPI | undefined;
		const { harness, notifications, saved, servers } = await setup("direct", undefined, {
			extensionFactories: [
				(host) => {
					api = host;
				},
			],
		});
		await harness.session.prompt("/mcp list");
		expect(notifications.at(-1)).toContain("docs: enabled · connected");
		expect(getMcpSessionStatus(api!.events)).toMatchObject([
			{ name: "docs", enabled: true, state: "connected", exposure: "direct", toolCount: 3 },
		]);
		await harness.session.prompt("/mcp enable docs");
		expect(servers).toHaveLength(1);
		await harness.session.prompt("/mcp disable docs");
		expect(saved.at(-1)).toEqual({ enabled: false });
		expect(getMcpSessionStatus(api!.events)).toMatchObject([{ enabled: false, state: "disabled" }]);
		expect(nestedToolNames(harness)).not.toContain("mcp__docs__search");
		await harness.session.prompt("/mcp exposure docs direct");
		expect(saved.at(-1)).toEqual({ exposure: "direct" });
		await harness.session.prompt("/mcp enable docs");
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search");
		await harness.session.prompt("/mcp exposure docs hidden");
		expect(nestedToolNames(harness)).not.toContain("mcp__docs__search");
		await harness.session.prompt("/mcp exposure docs direct");
		expect(nestedToolNames(harness)).toContain("mcp__docs__search");
		const count = saved.length;
		for (const removed of ["deferred", "auto", "nonsense"]) {
			await harness.session.prompt(`/mcp exposure docs ${removed}`);
			expect(saved).toHaveLength(count);
			expect(notifications.at(-1)).toContain("Usage:");
		}
	});

	it("includes extension registrations alongside configured servers in the common status list", async () => {
		const { harness, notifications } = await setup("direct", undefined, {
			extensionFactories: [
				(api) => {
					api.registerMcpServer("octocode", { command: "fixture", exposure: "direct" });
				},
			],
		});
		await vi.waitFor(() =>
			expect(harness.session.getAllTools().some((tool) => tool.name === "mcp__octocode__search")).toBe(true),
		);
		await harness.session.prompt("/mcp list");
		expect(notifications.at(-1)).toContain("docs: enabled · connected");
		expect(notifications.at(-1)).toContain("octocode: enabled · connected, 3 tools");
	});

	it("restores the same tool definition after reconnecting an unchanged validated catalog", async () => {
		const { harness, registrations } = await setup("direct");
		const original = registrations.find((tool) => tool.name === "mcp__docs__search");
		expect(original).toBeDefined();
		await harness.session.prompt("/mcp reconnect docs");
		expect(registrations.filter((tool) => tool.name === "mcp__docs__search").at(-1)).toBe(original);
		expect(nestedToolNames(harness)).toContain("mcp__docs__search");
	});

	it("does not start a server --tools does not reach", async () => {
		let api: ExtensionAPI | undefined;
		const { harness, servers } = await setup("direct", undefined, {
			allowedToolNames: ["bash"],
			waitForTools: false,
			extensionFactories: [
				(host) => {
					api = host;
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("go");

		expect(servers).toHaveLength(0);
		expect(harness.session.getActiveToolNames()).toEqual(["bash"]);
		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("mcp__docs__search");
		expect(getMcpSessionStatus(api!.events)).toMatchObject([{ name: "docs", enabled: true, state: "unselected" }]);
		expect(serversSection(harness)).toBeUndefined();
	});

	it("removes MCP tools with --no-tools", async () => {
		// An empty allowlist reaches no server, so none starts.
		const { harness, servers } = await setup("direct", undefined, { allowedToolNames: [], waitForTools: false });
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("go");

		expect(servers).toHaveLength(0);
		expect(harness.session.getAllTools()).toEqual([]);
		expect(harness.session.getActiveToolNames()).toEqual([]);
	});

	it("does not declare MCP tools restored from the transcript when --tools leaves their server out", async () => {
		const first = await setup("direct");
		first.harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await first.harness.session.prompt("first");
		await first.harness.session.prompt("second");
		expect(declaredToolNames(first.harness)).toContain("mcp__docs__search");

		// Like `octocode --tools bash -c` followed by /tree.
		const second = await setup("direct", undefined, {
			allowedToolNames: ["bash"],
			sessionManager: first.harness.sessionManager,
			waitForTools: false,
		});
		const firstAssistant = second.harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!firstAssistant) throw new Error("No assistant entry");
		await second.harness.session.navigateTree(firstAssistant.id);

		// The transcript's loadout is restored without the MCP tools it declared, whose server never starts.
		expect(second.harness.session.getActiveToolNames()).toEqual([]);
		expect(second.harness.session.getAllTools().map((tool) => tool.name)).not.toContain("mcp__docs__search");
		expect(second.servers).toHaveLength(0);
	});

	it("filters MCP tools by the mcp__ entries of --tools", async () => {
		const { harness } = await setup("direct", undefined, {
			allowedToolNames: ["mcp__docs__s*"],
			resources: true,
		});
		await vi.waitFor(() =>
			expect(harness.session.getActiveToolNames()).toEqual(["mcp__docs__search", "mcp__docs__shot"]),
		);
		const registered = harness.session.getAllTools().map((tool) => tool.name);
		expect(registered).toEqual(expect.arrayContaining(["mcp__docs__search", "mcp__docs__shot"]));
		expect(registered).not.toContain("mcp__docs__fail");
		expect(registered).not.toContain("list_mcp_resources");
	});

	it("removes MCP tools matching --exclude-tools patterns", async () => {
		const { harness } = await setup("direct", undefined, { excludedToolNames: ["mcp__docs__f*"] });
		const registered = harness.session.getAllTools().map((tool) => tool.name);
		expect(registered).toContain("mcp__docs__search");
		expect(registered).not.toContain("mcp__docs__fail");
	});

	it("keeps MCP tools declared and callable across tree navigation", async () => {
		const { harness } = await setup("direct");
		const searchName = createMcpToolName("docs", "search");
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		expect(harness.session.getActiveToolNames()).toContain(searchName);

		const firstAssistant = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!firstAssistant) throw new Error("No assistant entry");
		await harness.session.navigateTree(firstAssistant.id);

		expect(harness.session.getActiveToolNames()).toContain(searchName);
		expect(nestedToolNames(harness)).toContain(searchName);
	});

	// Regression: #10239.
	it.each([false, true])("routes tools whose names differ only in - and _ (reverse: %s)", async (reverse) => {
		const tools = [
			{ name: "read-file", description: "dashed", inputSchema: { type: "object", properties: {} } },
			{ name: "read_file", description: "underscored", inputSchema: { type: "object", properties: {} } },
		];
		if (reverse) tools.reverse();
		const { harness, calls } = await setup("direct", () => [...tools, ...SERVER_TOOLS], { presentation: "json" });
		const names = harness.session.getAllTools();
		const dashed = names.find((tool) => tool.description === "dashed")!.name;
		const underscored = names.find((tool) => tool.description === "underscored")!.name;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(dashed, {}), fauxToolCall(underscored, {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(calls).toEqual(["read-file:{}", "read_file:{}"]);
	});

	it("rejects model calls to hidden MCP tools as not active, without calling the server", async () => {
		const { harness, calls } = await setup("hidden");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(createMcpToolName("docs", "search"), { query: "x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = toolResult(harness, "mcp__docs__search");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe(
			"Tool mcp__docs__search not found: it is not active in this session. Use another tool, or ask the user to enable it.",
		);
		expect(calls).toEqual([]);
	});

	it.each([undefined, "direct"] as const)("declares MCP tools directly with exposure %s", async (exposure) => {
		const { harness } = await setup(exposure);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "direct" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(declaredToolNames(harness)).toEqual(["mcp__docs__fail", "mcp__docs__search", "mcp__docs__shot"]);
		expect(harness.session.getActiveToolNames()).not.toContain("codemode");
		expect(harness.session.getActiveToolNames()).not.toContain("tool_search");
		// Server annotations never reach host permission policy.
		const annotations = new Map(harness.session.getAllTools().map((tool) => [tool.name, tool.annotations]));
		expect(annotations.get("mcp__docs__fail")).toBeUndefined();
		expect(annotations.get("mcp__docs__search")).toBeUndefined();
		const result = toolResult(harness, "mcp__docs__search");
		expect(getMessageText(result)).toBe("direct guide\ndirect faq");
	});

	it("withdraws and restores MCP tools the server changes", async () => {
		let tools = SERVER_TOOLS;
		const { harness, servers } = await setup("direct", () => tools);
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");
		const reachable = () => harness.session.getActiveToolNames();
		const listChanged = async () => {
			await servers[0].send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
			await new Promise((resolve) => setTimeout(resolve, 10));
		};
		expect(reachable()).toContain("mcp__docs__fail");

		tools = SERVER_TOOLS.filter((tool) => tool.name !== "fail");
		await listChanged();
		expect(reachable()).not.toContain("mcp__docs__fail");
		expect(reachable()).toContain("mcp__docs__search");

		tools = SERVER_TOOLS;
		await listChanged();
		expect(reachable()).toContain("mcp__docs__fail");
	});

	it("does not register or call resource tools when a server advertises resources", async () => {
		const { harness, calls } = await setup("direct", undefined, { resources: true });
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		const names = harness.session.getAllTools().map((tool) => tool.name);
		for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"])
			expect(names).not.toContain(name);
		expect(calls).toEqual([]);
	});

	it("applies per-tool exposure overrides", async () => {
		const { harness } = await setup("hidden", undefined, { toolExposure: { search: "direct" } });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		// `search` is declared; `fail` and `shot` keep the server's `hidden`.
		expect(declaredToolNames(harness)).toEqual(["mcp__docs__search"]);
		expect(nestedToolNames(harness)).toEqual(["mcp__docs__search"]);
	});

	it("gives each server one contract section with its full instructions once (json)", async () => {
		const { harness } = await setup("direct", undefined, {
			instructions: "Docs search.\nLong guidance.",
			presentation: "json",
		});
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("go");

		const section = serversSection(harness);
		expect(section).toContain(
			"MCP server mcp__docs: call its tools as mcp__docs__<tool>; their declarations carry the full descriptions and schemas.\nDocs search.\nLong guidance.",
		);
		expect(section?.match(/Docs search\./g)).toHaveLength(1);
		expect(section).not.toContain("tool_search");
	});

	it("places server contracts in the base sections, ahead of the session's own sections", async () => {
		const { harness } = await setup("direct", undefined, { instructions: "Docs search." });
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		const first = harness.session.messages.find((message): message is SystemMessage => message.role === "system");
		const names = Object.keys(first?.sections ?? {});
		expect(names).toContain("mcp_contract_docs");
		expect(names.indexOf("mcp_contract_docs")).toBeLessThan(names.indexOf("cwd"));
		expect(names).not.toContain(MCP_STATUS_SECTION);
	});

	it("caches full default contracts and instructions without repeating them on an unchanged prompt (json)", async () => {
		const instructions = `First rule.\n${"Detailed server guidance.\n".repeat(400)}FINAL_RULE`;
		const description = `Search exactly.\n${"Full tool guidance.\n".repeat(60)}FINAL_DESCRIPTION`;
		const tools = [{ ...SERVER_TOOLS[0], description }, ...SERVER_TOOLS.slice(1)];
		const { harness } = await setup(undefined, () => tools, {
			instructions,
			toolExposure: { fail: "hidden" },
			excludedToolNames: ["mcp__docs__shot"],
			presentation: "json",
		});
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		const initial = harness.session.messages.filter((m): m is SystemMessage => m.role === "system");
		const declarations = initial.flatMap((m) => m.toolsAdded ?? []);
		const search = declarations.find((t) => t.name === "mcp__docs__search");
		expect(search).toMatchObject({
			description: `${description}\n\nServer result schema:\n${JSON.stringify(SERVER_TOOLS[0].outputSchema)}`,
			parameters: SERVER_TOOLS[0].inputSchema,
		});
		expect(declarations.map((t) => t.name)).not.toContain("mcp__docs__fail");
		expect(declarations.map((t) => t.name)).not.toContain("mcp__docs__shot");
		expect(serversSection(harness)).toContain(instructions);
		expect(serversSection(harness)?.match(/FINAL_RULE/g)).toHaveLength(1);
		expect(serversSection(harness)).not.toContain("tool_search");
		expect(serversSection(harness)).not.toContain("declared: fail");
		await harness.session.prompt("second");
		expect(harness.session.messages.filter((m) => m.role === "system")).toEqual(initial);
	});

	it("caches thin declarations, the generated contract and instructions on an unchanged prompt (compact)", async () => {
		const instructions = `First rule.\n${"Detailed server guidance.\n".repeat(400)}FINAL_RULE`;
		const description = `Search exactly.\n${"Full tool guidance.\n".repeat(60)}FINAL_DESCRIPTION`;
		const tools = [{ ...SERVER_TOOLS[0], description }, ...SERVER_TOOLS.slice(1)];
		const { harness } = await setup(undefined, () => tools, {
			instructions,
			toolExposure: { fail: "hidden" },
			excludedToolNames: ["mcp__docs__shot"],
			presentation: "compact",
		});
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		const initial = harness.session.messages.filter((m): m is SystemMessage => m.role === "system");
		const declarations = initial.flatMap((m) => m.toolsAdded ?? []);
		// The declaration keeps the first sentence and top-level field types; the full schema is only validated.
		expect(declarations.find((t) => t.name === "mcp__docs__search")).toMatchObject({
			description: "Search exactly.",
			parameters: { type: "object", properties: { query: { type: "string" } }, additionalProperties: true },
		});
		expect(declarations.map((t) => t.name)).not.toContain("mcp__docs__fail");
		expect(declarations.map((t) => t.name)).not.toContain("mcp__docs__shot");
		const section = serversSection(harness);
		expect(section).toContain(instructions.split("\n")[0]);
		expect(section).toContain("function search(");
		expect(section?.match(/FINAL_RULE/g)).toHaveLength(1);
		expect(section).not.toContain("tool_search");
		await harness.session.prompt("second");
		expect(harness.session.messages.filter((m) => m.role === "system")).toEqual(initial);
	});

	it("omits the contract and instructions of a server --tools leaves out", async () => {
		const { harness } = await setup("direct", undefined, {
			instructions: "PRIVATE_SERVER_RULE",
			allowedToolNames: ["bash"],
			waitForTools: false,
		});
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(serversSection(harness) ?? "").not.toContain("PRIVATE_SERVER_RULE");
	});

	it.each([
		["json", "MCP server mcp__docs:"],
		["compact", "function search("],
	] as const)(
		"keeps the instructions while one of the server's tools stays selected (%s)",
		async (presentation, listing) => {
			const { harness } = await setup("direct", undefined, { instructions: "LOADED_RULE", presentation });
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("done")]);
			await harness.session.prompt("first");
			harness.session.setActiveToolsByName(["mcp__docs__search"]);
			await harness.session.prompt("next");
			const section = serversSection(harness);
			expect(section).toContain("LOADED_RULE");
			expect(section).toContain(listing);
			if (presentation === "compact") expect(section).not.toContain("function fail(");
			expect(section).not.toContain("tool_search");
		},
	);

	/** A server named `slow` whose answer to `initialize` takes `initializeDelayMs`, without waiting for it. */
	async function setupSlow(
		config: {
			exposure?: McpExposure;
			toolExposure?: Record<string, McpExposure>;
			name?: string;
			instructions?: string;
			presentation?: McpPresentationMode;
		},
		initializeDelayMs: number,
		startupWaitMs?: number,
	) {
		const calls: string[] = [];
		const notifications: string[] = [];
		const { name = "slow", instructions, presentation, ...serverConfig } = config;
		const entry: McpServerEntry = {
			name,
			config: { url: "http://unused.invalid", ...serverConfig },
			source: "test",
		};
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					createTransport: () => {
						const pair = createFakeServer(calls, { initializeDelayMs, instructions });
						void pair.server.start();
						return pair.client;
					},
					...(startupWaitMs === undefined ? {} : { startupWaitMs }),
					...(presentation ? { presentation } : {}),
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		return { harness, calls, notifications };
	}

	it("names a server still connecting after the startup wait in mcp_status, not in a contract", async () => {
		const { harness, notifications } = await setupSlow({}, Number.POSITIVE_INFINITY, 50);
		harness.setResponses([fauxAssistantMessage("ready")]);

		const started = Date.now();
		await harness.session.prompt("start");

		expect(Date.now() - started).toBeLessThan(1500);
		expect(getAssistantTexts(harness)).toEqual(["ready"]);
		const section = serversSection(harness);
		expect(section).toContain("- mcp__slow: connecting");
		expect(section).not.toContain("mcp_contract_slow");
		expect(notifications).toEqual(["MCP servers are still connecting; their tools become available once connected."]);
	});

	it("appends a late server's contract with the next prompt and drops its status line", async () => {
		const { harness } = await setupSlow({ instructions: "Slow docs.\nMore." }, 60, 10);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

		await harness.session.prompt("first");
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__slow__search"));
		await harness.session.prompt("second");

		const systemMessages = harness.session.messages.filter(
			(message): message is SystemMessage => message.role === "system",
		);
		expect(systemMessages[0].sections?.[MCP_STATUS_SECTION]).toContain("- mcp__slow: connecting");
		expect(Object.keys(systemMessages[0].sections ?? {})).not.toContain("mcp_contract_slow");
		const update = systemMessages.find((message) => message.sections?.mcp_contract_slow);
		expect(update).toBeDefined();
		// Only the late server's sections change: its contract arrives and the status line goes.
		expect(Object.keys(update!.sections!).sort()).toEqual([MCP_STATUS_SECTION, "mcp_contract_slow"].sort());
		expect(update!.sections![MCP_STATUS_SECTION]).toBeNull();
		expect(update!.sections!.mcp_contract_slow).toContain("Slow docs. More.");
		expect(harness.session.messages.indexOf(update!)).toBeGreaterThan(
			harness.session.messages.findIndex((message) => message.role === "assistant"),
		);
	});

	it("waits for servers with direct tools before describing them", async () => {
		const { harness } = await setupSlow(
			{ exposure: "direct", toolExposure: { shot: "hidden" }, instructions: "Slow docs." },
			30,
		);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		const section = serversSection(harness);
		expect(section).toContain("function search(");
		expect(section).not.toContain("function shot(");
		expect(section).not.toContain("connecting");
	});

	it("describes a server with only direct tools by its instructions and full declarations (json)", async () => {
		const { harness } = await setupSlow(
			{ exposure: "direct", instructions: "Slow docs.\nSearch, then read.", presentation: "json" },
			0,
		);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		const section = serversSection(harness);
		expect(section).toContain(
			"MCP server mcp__slow: call its tools as mcp__slow__<tool>; their declarations carry the full descriptions and schemas.\nSlow docs.\nSearch, then read.",
		);
		expect(section).not.toContain("tool_search");
	});

	it("describes a server with only direct tools by its generated contract (compact)", async () => {
		const { harness } = await setupSlow(
			{ exposure: "direct", instructions: "Slow docs.\nSearch, then read.", presentation: "compact" },
			0,
		);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		const section = serversSection(harness);
		expect(section).toContain("/** Slow docs. Search, then read. */\ndeclare namespace slow {");
		for (const name of ["fail", "search", "shot"]) expect(section).toContain(`function ${name}(`);
		expect(section).not.toContain("tool_search");
	});

	it("holds the first prompt for servers with direct tools", async () => {
		const { harness } = await setupSlow({ exposure: "direct" }, 30);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(declaredToolNames(harness)).toContain("mcp__slow__search");
	});

	it("holds the first prompt for servers with direct tools only up to startupWaitMs", async () => {
		const { harness, notifications } = await setupSlow({ exposure: "direct" }, Number.POSITIVE_INFINITY, 20);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(getAssistantTexts(harness)).toEqual(["ready"]);
		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(notifications).toEqual(["MCP servers are still connecting; their tools become available once connected."]);
	});

	it("keeps MCP tools callable after compaction and resume", async () => {
		const { harness, calls } = await setup("direct", undefined, {
			builtinCompactionFactories: [
				(api) => {
					api.on("session_before_compact", async ({ preparation }) => ({
						compaction: {
							summary: "Found the documentation tool; continue the lookup.",
							firstKeptEntryId: preparation.firstKeptEntryId,
							tokensBefore: preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "before" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Found the first result."),
			fauxAssistantMessage("Ready for the next lookup."),
		]);
		await harness.session.prompt("Find documentation");
		await harness.session.prompt("Remember the result");
		await harness.session.compact();
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		expect(getCurrentTools(harness.sessionManager.buildSessionContext().messages).map((tool) => tool.name)).toContain(
			"mcp__docs__search",
		);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "after" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done after compaction."),
		]);
		await harness.session.prompt("Continue");
		expect(calls).toEqual(['search:{"query":"before"}', 'search:{"query":"after"}']);
		const resumed = await setup("direct", undefined, { sessionManager: harness.sessionManager });
		resumed.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "resumed" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done after resume."),
		]);
		await resumed.harness.session.prompt("Continue after resume");
		expect(resumed.calls).toEqual(['search:{"query":"resumed"}']);
	});

	it("calls the default catalog directly without registering codemode or discovery", async () => {
		const { harness, calls } = await setup(undefined);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "automatic" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Search docs");
		expect(calls).toEqual(['search:{"query":"automatic"}']);
		expect(harness.session.getActiveToolNames()).not.toContain("tool_search");
		expect(harness.session.getActiveToolNames()).not.toContain("codemode");
	});
});

describe("AgentSession MCP servers registered by extensions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** `configured` are the mcp.json servers; `plugins` register servers through the extension API. */
	async function setup(plugins: ExtensionFactory | ExtensionFactory[], configured: McpServerEntry[] = []) {
		const connected: McpServerEntry[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				...(Array.isArray(plugins) ? plugins : [plugins]),
				createMcpExtension({
					loadConfig: () => ({ servers: configured, errors: [] }),
					createTransport: (entry) => {
						connected.push(entry);
						const pair = createFakeServer([]);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		// `/reload` emits session_start only to bound extensions.
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return { harness, connected };
	}

	it("connects servers registered while extensions load", async () => {
		const { harness, connected } = await setup((api) => {
			api.registerMcpServer("plugin", { url: "http://plugin.invalid", exposure: "direct" });
		});
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(connected.map((entry) => [entry.name, entry.scope])).toEqual([["plugin", "extension"]]);
		expect(harness.session.getActiveToolNames()).toContain("mcp__plugin__search");
	});

	it("connects and disconnects servers registered during the session", async () => {
		let api: ExtensionAPI | undefined;
		const { harness, connected } = await setup((host) => {
			api = host;
		});
		if (!api) throw new Error("No extension API");
		const host = api;

		host.registerMcpServer("late", { url: "http://late.invalid" });
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__late__search"));
		expect(connected.map((entry) => entry.name)).toEqual(["late"]);
		// Small catalogs on the default model are directly callable.
		expect(harness.session.getActiveToolNames()).toContain("mcp__late__search");

		host.unregisterMcpServer("late");
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).not.toContain("mcp__late__search"));
	});

	// "my_docs" shares the namespace of "my-docs" (#10239).
	it.each(["my-docs", "my_docs"])("prefers the mcp.json server over a registered %s", async (name) => {
		const configured: McpServerEntry = {
			name: "my-docs",
			config: { url: "http://config.invalid" },
			source: "mcp.json",
		};
		const { connected } = await setup(
			(api) => {
				api.registerMcpServer(name, { url: "http://plugin.invalid" });
			},
			[configured],
		);
		await vi.waitFor(() => expect(connected).toEqual([configured]));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(connected).toEqual([configured]);
	});

	it("rejects names another extension registered", async () => {
		const errors: string[] = [];
		await setup([
			(api) => {
				api.registerMcpServer("taken", { url: "http://x.invalid" });
				// Registering again replaces the extension's own registration.
				api.registerMcpServer("taken", { url: "http://y.invalid" });
				api.registerMcpServer("my-server", { url: "http://x.invalid" });
			},
			(api) => {
				for (const name of ["taken", "my_server"]) {
					try {
						api.registerMcpServer(name, { url: "http://z.invalid" });
					} catch (caught) {
						errors.push(String(caught));
					}
				}
			},
		]);
		expect(errors).toEqual([
			expect.stringMatching(/MCP server "taken" is already registered by extension/),
			// Names that differ only in - and _ share a namespace (#10239).
			'Error: MCP server "my_server" conflicts with registered server "my-server"',
		]);
	});

	it("reports registered servers when no extension connects them", async () => {
		const harness = await createHarness({
			extensionFactories: [(api) => api.registerMcpServer("orphan", { url: "http://orphan.invalid" })],
		});
		harnesses.push(harness);
		const errors: string[] = [];
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });

		expect(errors).toEqual([expect.stringContaining('MCP server "orphan" is registered, but no loaded extension')]);
	});
});

describe("AgentSession MCP tools after resume and reload", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/**
	 * A `docs` server that answers `initialize` after `initializeDelayMs`; the first prompt waits for it only briefly, so
	 * a slower one connects after that prompt starts. `connected` counts its connections. `/reload` loads the
	 * extensions again.
	 */
	async function setup(
		sessionManager?: SessionManager,
		extensionFactories: ExtensionFactory[] = [],
		initializeDelayMs = 0,
		initializeFails = false,
	) {
		const connected: string[] = [];
		const eventBus = createEventBus();
		const servers: McpServerEntry[] = [{ name: "docs", config: { url: "http://unused.invalid" }, source: "test" }];
		const factories = [
			...extensionFactories,
			createMcpExtension({
				loadConfig: () => ({ servers, errors: [] }),
				startupWaitMs: 20,
				createTransport: (entry) => {
					connected.push(entry.name);
					const pair = createFakeServer([], { initializeDelayMs, initializeFails });
					void pair.server.start();
					return pair.client;
				},
			}),
		];
		let extensions = await createTestExtensionsResult(factories, undefined, eventBus);
		const resourceLoader = {
			...createTestResourceLoader(),
			getEventBus: () => eventBus,
			getExtensions: () => extensions,
			reload: async () => {
				extensions = await createTestExtensionsResult(factories, undefined, eventBus);
			},
		};
		const harness = await createHarness({ resourceLoader, sessionManager });
		harnesses.push(harness);
		// A resumed session starts from its transcript, like `createAgentSession` does.
		if (sessionManager) harness.session.agent.state.messages = sessionManager.buildSessionContext().messages;
		// `/reload` emits session_start only to bound extensions.
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return { harness, connected, eventBus };
	}

	/** A first prompt once the server's tools are declared, so the transcript records them. */
	async function declareDocs(harness: Harness) {
		await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search"));
		harness.setResponses([fauxAssistantMessage("declared")]);
		await harness.session.prompt("go");
		expect(getCurrentTools(harness.session.messages).map((tool) => tool.name)).toContain("mcp__docs__search");
	}

	it("declares restored MCP tools again on resume once their server connects", async () => {
		const first = await setup();
		await declareDocs(first.harness);

		// The session restores its tools before the server connects again.
		const second = await setup(first.harness.sessionManager);
		await vi.waitFor(() => expect(second.harness.session.getActiveToolNames()).toContain("mcp__docs__search"));
		second.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "again" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await second.harness.session.prompt("use it");

		expect(getMessageText(toolResult(second.harness, "mcp__docs__search"))).toBe("again guide\nagain faq");
		const removals = second.harness.session.messages.filter(
			(message) => message.role === "system" && (message.toolsRemoved ?? []).length > 0,
		);
		expect(removals).toEqual([]);
	});

	// Tools active by default come back when their server registers them, whatever loadout an extension set before.
	it.each([
		["a replaced", ["bash"]],
		["an extended", undefined],
	] as const)("keeps restored MCP tools after %s loadout before they register", async (_, loadout) => {
		const first = await setup();
		await declareDocs(first.harness);

		// Like plan mode restoring its tools, or an extension adding one to the current loadout.
		const setLoadout: ExtensionFactory = (api) => {
			api.on("session_start", () =>
				api.setActiveTools(loadout ? [...loadout] : [...api.getActiveTools(), "extra_tool"]),
			);
		};
		const second = await setup(first.harness.sessionManager, [setLoadout]);
		await vi.waitFor(() =>
			expect(second.harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
		);

		await vi.waitFor(() => expect(second.harness.session.getActiveToolNames()).toContain("mcp__docs__search"));
	});

	it("activates restored tools that register after the next prompt starts", async () => {
		const first = await setup();
		await declareDocs(first.harness);

		// The first prompt waits for the server only up to the startup wait.
		const second = await setup(first.harness.sessionManager, [], 200);
		second.harness.setResponses([fauxAssistantMessage("done")]);
		await second.harness.session.prompt("go");
		expect(second.harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(false);
		expect(getMcpSessionStatus(second.eventBus)[0].state).not.toBe("connected");
		// The tool is still declared to the model while its server connects.
		expect(second.harness.session.messages.filter(hasToolsRemoved)).toEqual([]);
		expect(getCurrentTools(second.harness.session.messages).map((tool) => tool.name)).toContain("mcp__docs__search");

		await vi.waitFor(() => expect(second.harness.session.getActiveToolNames()).toContain("mcp__docs__search"));
		second.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "late" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await second.harness.session.prompt("use it");
		expect(getMessageText(toolResult(second.harness, "mcp__docs__search"))).toBe("late guide\nlate faq");
		expect(second.harness.session.messages.filter(hasToolsRemoved)).toEqual([]);
	});

	it("tells the model a declared restored tool is still connecting instead of reporting it missing", async () => {
		const first = await setup();
		await declareDocs(first.harness);

		const second = await setup(first.harness.sessionManager, [], 200);
		second.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "early" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("retry later"),
		]);
		await second.harness.session.prompt("too early");
		const early = toolResult(second.harness, "mcp__docs__search");
		expect(early.isError).toBe(true);
		expect(getMessageText(early)).toMatch(/still connecting/);
		expect(second.harness.session.messages.filter(hasToolsRemoved)).toEqual([]);

		await vi.waitFor(() => expect(second.harness.session.getActiveToolNames()).toContain("mcp__docs__search"));
		second.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "now" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await second.harness.session.prompt("again");
		const results = second.harness.session.messages.filter((message) => message.role === "toolResult");
		expect(getMessageText(results.at(-1)!)).toBe("now guide\nnow faq");
	});

	it("drops restored tools when their server fails after the next prompt starts", async () => {
		const first = await setup();
		await declareDocs(first.harness);

		const second = await setup(first.harness.sessionManager, [], 100, true);
		second.harness.setResponses([fauxAssistantMessage("done")]);
		await second.harness.session.prompt("go");
		await vi.waitFor(() => expect(getMcpSessionStatus(second.eventBus)[0].state).toBe("failed"));

		expect(second.harness.session.getActiveToolNames()).not.toContain("mcp__docs__search");
	});

	it("declares MCP tools again after /reload", async () => {
		const { harness, connected } = await setup();
		await declareDocs(harness);

		await harness.session.reload();

		await vi.waitFor(() => expect(connected).toEqual(["docs", "docs"]));
		await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search"));
	});
});
