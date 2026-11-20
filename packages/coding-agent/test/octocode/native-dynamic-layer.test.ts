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

const webTool = () => ({
	name: "web",
	label: "web",
	description: "Search the web. Second sentence.",
	parameters: Type.Object({
		reason: Type.String(),
		op: Type.Union([Type.Literal("search"), Type.Literal("fetch")]),
		queries: Type.Optional(Type.Array(Type.Object({ url: Type.String() }))),
	}),
	execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} })),
});

/** A host whose native `web` tool is declared deferred, as `recent` does for a tool no session called. */
async function session(model: Model<Api> = changes, settings: Record<string, unknown> = { mcpExposure: "recent" }) {
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp());
	const host = fakeHost(settings);
	const api = withNativePermissionOwners(host.api);
	const full = webTool();
	api.tools.register(full as never);
	const ctx = {
		model,
		sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
	} as never;
	await host.fire("session_start", {}, ctx);
	const registered = () => host.tools.get("web");
	const thin = registered();
	const ended = (toolName = "mcp") => host.fire("tool_execution_end", { toolName }, ctx);
	return { host, full, thin, registered, ended, ctx };
}

describe("the native tools port the mcp tool reads", () => {
	it("describes the tools this session declares thin, in full, and nothing else", async () => {
		const s = await session();
		const port = nativeToolsPort();
		expect(port.deferred()).toContain("web");
		expect(port.schema("web")).toEqual({
			description: "Search the web. Second sentence.",
			parameters: s.full.parameters,
		});
		expect(port.schema("bash")).toBeUndefined();
		expect(port.schema("nope")).toBeUndefined();
	});

	it("does not list a tool the session declares in full", async () => {
		await session(changes, { mcpExposure: "direct" });
		expect(nativeToolsPort().deferred()).not.toContain("web");
		expect(nativeToolsPort().schema("web")).toBeUndefined();
	});
});

describe("a deferred native tool after it is loaded", () => {
	it("is declared in full once, in place, on a transport with native tool changes", async () => {
		const s = await session();
		expect(s.thin.parameters).not.toBe(s.full.parameters);
		nativeToolsPort().loaded?.("web");
		// Nothing changes while the `mcp` tool call that loaded it is still running.
		expect(s.registered()).toBe(s.thin);
		await s.ended();
		expect(s.registered()?.parameters).toBe(s.full.parameters);
		const declared = s.registered();
		nativeToolsPort().loaded?.("web");
		await s.ended();
		expect(s.registered()).toBe(declared);
	});

	it("stays thin on a transport that would resend its whole tool list", async () => {
		const s = await session(plain);
		nativeToolsPort().loaded?.("web");
		await s.ended();
		expect(s.registered()).toBe(s.thin);
	});

	it("is declared in full after a refused call and after a first call", async () => {
		const refused = await session();
		refused.thin?.validationHint?.({ envelope: false, properties: ["op"] });
		await refused.ended("web");
		expect(refused.registered()?.parameters).toBe(refused.full.parameters);

		const first = await session();
		await first.thin?.execute("id", { reason: "r", op: "search" }, undefined, undefined, first.ctx);
		await first.ended("web");
		expect(first.registered()?.parameters).toBe(first.full.parameters);
	});

	it("is not declared in full when nothing loaded it, and a new session starts thin again", async () => {
		const s = await session();
		await s.ended("bash");
		expect(s.registered()).toBe(s.thin);
		nativeToolsPort().loaded?.("web");
		await s.ended();
		await s.host.fire("session_start", {}, s.ctx);
		expect(s.registered()?.parameters).toBe(s.thin?.parameters);
	});

	it("keeps the tool list and instruction blocks first sent, adding one tool_addition after them", async () => {
		const s = await session();
		const before = s.registered() as Tool;
		nativeToolsPort().loaded?.("web");
		await s.ended();
		const after = s.registered() as Tool;
		const first: Message[] = [
			{ role: "system", content: "base prompt", toolsAdded: [toToolDeclaration(before)], timestamp: 0 },
			{ role: "user", content: "search", timestamp: 1 },
		];
		const update = getToolStateChanges(getCurrentTools(first), [toToolDeclaration(after)]);
		expect(update.toolsAdded.map((tool) => tool.name)).toEqual(["web"]);
		const later: Message[] = [
			...first,
			{ role: "system", content: "", ...update, timestamp: 2 },
			{ role: "user", content: "again", timestamp: 3 },
		];
		const sent = await payloadOf(changes, first);
		const next = await payloadOf(changes, later);
		expect(JSON.stringify(next.tools)).toBe(JSON.stringify(sent.tools));
		expect(JSON.stringify(next.system)).toBe(JSON.stringify(sent.system));
		expect(sent.tools?.find((tool) => tool.name === "web")?.input_schema).toMatchObject({ additionalProperties: true });
		expect(additions(sent)).toEqual([]);
		const added = additions(next);
		expect(added).toHaveLength(1);
		expect(added[0].tool?.definition).toMatchObject({ name: "web", input_schema: { required: ["reason", "op"] } });
	});
});

describe("schemas of deferred natives after a compaction", () => {
	it("restores a called deferred native by name, and not one a tool result already shows", async () => {
		const s = await session();
		const declared = [s.registered() as never as { name: string; parameters: unknown }];
		const restored = restoredSchemas(declared, ["web"], ["web"], 24_000);
		expect(restored?.tools).toEqual(["web"]);
		expect(restored?.content).toContain(JSON.stringify(s.full.parameters));

		const read = formatMcpTool(
			{ name: "web", exposure: "deferred", description: "d", inputSchema: s.full.parameters as never },
			true,
		);
		const sent: unknown[] = [];
		const api = asSetup({
			getAllTools: () => declared as never,
			getActiveTools: () => ["web"],
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
					{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "web" }] } },
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
