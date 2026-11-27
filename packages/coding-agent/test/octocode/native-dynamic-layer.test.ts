import {
	type Api,
	getCurrentTools,
	getToolStateChanges,
	type Message,
	type Model,
	type Tool,
	toToolDeclaration,
} from "@octocodeai/octocode-ai";
import { streamSimple } from "@octocodeai/octocode-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMcpTool } from "../../../mcp/src/inspection.ts";
import { restoreDeferredSchemas, restoredSchemas } from "../../src/octocode/compaction/deferred-schemas.ts";
import { nativeToolsPort } from "../../src/octocode/permission/native-deferral.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { fakeHost, asSetup } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * Deferred native tools join the two tool layers MCP tools have: the cached tool list declares them thin, and a tool
 * loaded in the session (`mcp` tools, a refused call, a first call) is declared in full after the cache where the
 * transport adds tools in place.
 */
afterEach(() => vi.unstubAllEnvs());

const modelBase = {
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};
const changes: Model<Api> = {
	...modelBase,
	id: "claude-native",
	name: "Claude native",
	api: "anthropic-messages",
	provider: "anthropic",
	compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};
const plain: Model<Api> = { ...changes, id: "claude-plain", compat: { supportsMidConvoSystemMessages: true } };

/**
 * A deferrable native tool (`NATIVE_PINNABLE_TOOLS`) that is not left on demand, with a schema of its own. `web` was
 * the sample until it became a core tool, declared in full under every `mcpExposure`.
 */
const TOOL = "backlogPlan";
const deferrableTool = () => ({
	name: TOOL,
	label: TOOL,
	description: "Plan backlog items. Second sentence.",
	parameters: Type.Object({
		reason: Type.String(),
		op: Type.Union([Type.Literal("search"), Type.Literal("fetch")]),
		queries: Type.Optional(Type.Array(Type.Object({ url: Type.String() }))),
	}),
	execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} })),
});

/** A host whose native `backlogPlan` tool is declared deferred, as `recent` does for a tool no session called. */
async function session(model: Model<Api> = changes, settings: Record<string, unknown> = { mcpExposure: "recent" }) {
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp());
	const host = fakeHost(settings);
	const getAll = host.api.tools.getAll;
	host.api.tools.getAll = () =>
		getAll().map((tool) => ({
			...tool,
			sourceInfo: { ...tool.sourceInfo, owner: tool.name === "mcp" ? "builtin" : "native" },
		}));
	const mcpTools = { ...host.api.tools, setActive: vi.fn() };
	const port = nativeToolsPort({ tools: mcpTools });
	const api = withNativePermissionOwners(host.api);
	const full = deferrableTool();
	api.tools.register(full as never);
	const ctx = {
		model,
		sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
	} as never;
	await host.fire("session_start", {}, ctx);
	const registered = () => host.tools.get(TOOL);
	const thin = registered();
	const ended = (toolName = "mcp") => host.fire("tool_execution_end", { toolName }, ctx);
	return { host, api, mcpTools, port, full, thin, registered, ended, ctx };
}

describe("the native tools port the mcp tool reads", () => {
	it("describes the tools this session declares thin, in full, and nothing else", async () => {
		const s = await session();
		const port = s.port;
		expect(port.deferred()).toContain(TOOL);
		expect(port.schema(TOOL)).toEqual({
			description: "Plan backlog items. Second sentence.",
			parameters: s.full.parameters,
		});
		expect(port.schema("bash")).toBeUndefined();
		expect(port.schema("nope")).toBeUndefined();
	});

	it("reads and promotes only the calling registry, including its own management tool", async () => {
		const left = await session();
		const right = await session(changes, { mcpExposure: "direct" });
		const mcp = { ...deferrableTool(), name: "mcp", description: "Left management tool" };
		left.host.api.tools.register(mcp);
		expect(left.port.declared?.("mcp")?.description).toBe(mcp.description);
		expect(right.port.declared?.("mcp")).toBeUndefined();
		expect(left.port.schema(TOOL)?.parameters).toBe(left.full.parameters);
		expect(right.port.declared?.(TOOL)?.parameters).toBe(right.full.parameters);
		left.port.loaded?.(TOOL);
		await right.ended();
		expect(left.registered()).toBe(left.thin);
		await left.ended();
		expect(left.port.deferred()).not.toContain(TOOL);
		expect(left.port.declared?.(TOOL)?.parameters).toBe(left.full.parameters);
		left.host.api.tools.setActive(["mcp"]);
		expect(left.port.declared?.(TOOL)).toBeUndefined();
		left.port.loaded?.(TOOL);
		expect(left.host.api.tools.getActive()).toEqual(["mcp"]);
	});

	it("loads an eligible on-demand native but leaves unregistered, hidden and inactive tools unavailable", async () => {
		const s = await session(changes, { mcpExposure: "usage" });
		const api = s.host.api;
		const archive = { ...deferrableTool(), name: "archive" };
		api.tools.register({ ...archive, name: "mcp" });
		s.api.tools.register(archive);
		api.tools.register({ ...archive, name: "unavailable", defaultActive: false });
		await s.host.fire("session_start", {}, s.ctx);
		s.mcpTools.getHiddenDeclarations = () => [TOOL];
		expect(s.port.deferred()).toEqual(["archive"]);
		expect(s.port.schema("unavailable")).toBeUndefined();
		s.port.loaded?.("unavailable");
		s.port.loaded?.("missing");
		expect(api.tools.getActive()).not.toContain("unavailable");
		expect(s.port.schema("archive")?.parameters).toEqual(archive.parameters);
		s.port.loaded?.("archive");
		expect(api.tools.getActive()).toContain("archive");
		expect(s.mcpTools.setActive).not.toHaveBeenCalled();
		expect(s.port.declared?.("archive")?.parameters).toEqual(archive.parameters);
	});

	it("does not list a tool the session declares in full", async () => {
		const s = await session(changes, { mcpExposure: "direct" });
		expect(s.port.deferred()).not.toContain(TOOL);
		expect(s.port.schema(TOOL)).toBeUndefined();
	});
});

describe("a deferred native tool after it is loaded", () => {
	it("is declared in full once, in place, on a transport with native tool changes", async () => {
		const s = await session();
		expect(s.thin.parameters).not.toBe(s.full.parameters);
		s.port.loaded?.(TOOL);
		// Nothing changes while the `mcp` tool call that loaded it is still running.
		expect(s.registered()).toBe(s.thin);
		await s.ended();
		expect(s.registered()?.parameters).toBe(s.full.parameters);
		const declared = s.registered();
		s.port.loaded?.(TOOL);
		await s.ended();
		expect(s.registered()).toBe(declared);
	});

	it("stays thin on a transport that would resend its whole tool list", async () => {
		const s = await session(plain);
		s.port.loaded?.(TOOL);
		await s.ended();
		expect(s.registered()).toBe(s.thin);
	});

	it("is declared in full after a refused call and after a first call", async () => {
		const refused = await session();
		refused.thin?.validationHint?.({ envelope: false, properties: ["op"] });
		await refused.ended(TOOL);
		expect(refused.registered()?.parameters).toBe(refused.full.parameters);

		const first = await session();
		await first.thin?.execute("id", { reason: "r", op: "search" }, undefined, undefined, first.ctx);
		await first.ended(TOOL);
		expect(first.registered()?.parameters).toBe(first.full.parameters);
	});

	it("is not declared in full when nothing loaded it, and a new session starts thin again", async () => {
		const s = await session();
		await s.ended("bash");
		expect(s.registered()).toBe(s.thin);
		s.port.loaded?.(TOOL);
		await s.ended();
		await s.host.fire("session_start", {}, s.ctx);
		expect(s.registered()?.parameters).toBe(s.thin?.parameters);
	});

	it("keeps the tool list and instruction blocks first sent, adding one tool_addition after them", async () => {
		const s = await session();
		const before = s.registered() as Tool;
		s.port.loaded?.(TOOL);
		await s.ended();
		const after = s.registered() as Tool;
		const first: Message[] = [
			{ role: "system", content: "base prompt", toolsAdded: [toToolDeclaration(before)], timestamp: 0 },
			{ role: "user", content: "search", timestamp: 1 },
		];
		const update = getToolStateChanges(getCurrentTools(first), [toToolDeclaration(after)]);
		expect(update.toolsAdded.map((tool) => tool.name)).toEqual([TOOL]);
		const later: Message[] = [
			...first,
			{ role: "system", content: "", ...update, timestamp: 2 },
			{ role: "user", content: "again", timestamp: 3 },
		];
		const sent = await payloadOf(changes, first);
		const next = await payloadOf(changes, later);
		expect(JSON.stringify(next.tools)).toBe(JSON.stringify(sent.tools));
		expect(JSON.stringify(next.system)).toBe(JSON.stringify(sent.system));
		expect(sent.tools?.find((tool) => tool.name === TOOL)?.input_schema).toMatchObject({ additionalProperties: true });
		expect(additions(sent)).toEqual([]);
		const added = additions(next);
		expect(added).toHaveLength(1);
		expect(added[0].tool?.definition).toMatchObject({ name: TOOL, input_schema: { required: ["reason", "op"] } });
	});
});

describe("schemas of deferred natives after a compaction", () => {
	it("restores a called deferred native by name, and not one a tool result already shows", async () => {
		const s = await session();
		const declared = [s.registered() as never as { name: string; parameters: unknown }];
		const restored = restoredSchemas(declared, [TOOL], [TOOL], 24_000);
		expect(restored?.tools).toEqual([TOOL]);
		expect(restored?.content).toContain(JSON.stringify(s.full.parameters));

		const read = formatMcpTool(
			{ name: TOOL, exposure: "deferred", description: "d", inputSchema: s.full.parameters as never },
			true,
		);
		const sent: unknown[] = [];
		const api = asSetup({
			getAllTools: () => declared as never,
			getActiveTools: () => [TOOL],
			sendMessage: (message: unknown) => void sent.push(message),
		});
		const tail = {
			role: "toolResult",
			toolCallId: "1",
			toolName: "mcp",
			isError: false,
			content: [{ type: "text", text: read }],
		};
		const ctx = {
			model: { contextWindow: 200_000 },
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: TOOL }] } },
				],
				buildSessionProjection: () => ({ entries: [{ sourceEntry: { id: "e" }, messages: [tail] }] }),
			},
		} as never;
		expect(await restoreDeferredSchemas(api as never, ctx)).toEqual([]);
		expect(sent).toEqual([]);
	});
});

class PayloadCaptured extends Error {}

async function payloadOf(model: Model<Api>, messages: Message[]) {
	let captured: unknown;
	const stream = streamSimple(
		model,
		{ messages },
		{
			apiKey: "test-key",
			onPayload: (payload) => {
				captured = payload;
				throw new PayloadCaptured();
			},
		},
	);
	await stream.result();
	if (captured === undefined) throw new Error("expected a request payload");
	return captured as {
		system?: unknown;
		tools?: Array<{ name?: string; input_schema?: { required?: string[] } }>;
		messages: Array<{ role: string; content: unknown }>;
	};
}

const additions = (payload: Awaited<ReturnType<typeof payloadOf>>) =>
	payload.messages.flatMap((message) =>
		Array.isArray(message.content)
			? (message.content as Array<{ type: string; tool?: { definition?: { name?: string } } }>).filter(
					(block) => block.type === "tool_addition",
				)
			: [],
	);
