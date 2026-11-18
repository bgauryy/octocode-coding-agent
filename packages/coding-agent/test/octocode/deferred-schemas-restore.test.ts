import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createMcpToolDefinition } from "../../../mcp/src/tool-definition.ts";
import { deferredInputSchema, deferredParameters } from "../../../mcp/src/deferred-schema.ts";
import {
	calledTools,
	RESTORED_SCHEMAS_TYPE,
	RESTORE_SCHEMAS_CHARS,
	restoredSchemas,
	restoreDeferredSchemas,
} from "../../src/octocode/compaction/deferred-schemas.ts";
import { withNativeDeferral } from "../../src/octocode/permission/native-deferral.ts";
import { asSetup } from "./fake-host.ts";

const call = (...names: string[]) => ({
	role: "assistant",
	content: [{ type: "text", text: "working" }, ...names.map((name) => ({ type: "toolCall", id: name, name }))],
});
const nativeTool = (name: string) => ({
	name,
	label: name,
	description: `The ${name} tool.`,
	parameters: Type.Object({ reason: Type.String(), op: Type.Union([Type.Literal("search"), Type.Literal("fetch")]) }),
	execute: vi.fn(async () => ({ content: [], details: {} })),
});
const settings = (value: object) => asSetup({ getSettings: () => value }) as never;
/** Pinned, so no test reads the usage record of a real agent directory. */
const DEFERRED = { nativeToolExposure: { web: "deferred", archive: "deferred" } };
const DIRECT = { nativeToolExposure: { web: "direct" } };
const serverSchema = {
	type: "object",
	properties: { queries: { type: "array", items: { type: "object", properties: { pattern: { type: "string" } } } } },
	required: ["queries"],
};
const mcpTool = (name: string, deferred: boolean) =>
	createMcpToolDefinition({
		server: "octocode",
		tool: { name: "localSearch", description: "Search local code.", inputSchema: serverSchema },
		name,
		exposure: "direct",
		namespace: { name: "mcp__octocode" },
		timeoutMs: 1000,
		getClient: async () => ({}) as never,
		compact: { signature: () => undefined, whole: true, ...(deferred ? { deferred: true } : {}) },
	});

describe("schemas of deferred tools after a compaction", () => {
	it("keeps the full schema beside a deferred declaration only", () => {
		const web = withNativeDeferral(settings(DEFERRED), nativeTool("web") as never);
		expect(deferredInputSchema(web.parameters)).toBe(web.validationParameters);
		expect(
			deferredInputSchema(withNativeDeferral(settings(DIRECT), nativeTool("web") as never).parameters),
		).toBeUndefined();
		// An MCP tool remembers the server's schema as the server gave it; a thin tool its block describes does not.
		expect(deferredInputSchema(mcpTool("mcp__octocode__localSearch", true).parameters)).toBe(serverSchema);
		expect(deferredInputSchema(mcpTool("mcp__octocode__localSearch", false).parameters)).toBeUndefined();
		// Marking never touches the shared object it is given, and the declared parameters stay what they were.
		const shared = { type: "object", additionalProperties: true };
		const own = deferredParameters(shared, { full: true });
		expect(own).toEqual(shared);
		expect(deferredInputSchema(shared)).toBeUndefined();
		expect(JSON.stringify(own)).not.toContain("full");
	});

	it("lists the tools a session called, most recent first, each once", () => {
		expect(calledTools([call("web", "bash"), { role: "user", content: "next" }, call("archive"), call("web")])).toEqual(
			["web", "archive", "bash"],
		);
		expect(calledTools([{ role: "toolResult", toolName: "web", content: [] }, "text", null])).toEqual([]);
	});

	it("restores whole schemas of called, active, deferred tools within the budget", () => {
		const web = withNativeDeferral(settings(DEFERRED), nativeTool("web") as never);
		const search = mcpTool("mcp__octocode__localSearch", true);
		const declared = [
			web,
			search,
			nativeTool("bash"),
			withNativeDeferral(settings(DEFERRED), nativeTool("archive") as never),
		];
		const active = ["web", "mcp__octocode__localSearch", "bash"];
		const called = ["mcp__octocode__localSearch", "bash", "web", "archive", "gone"];
		const restored = restoredSchemas(declared, active, called, RESTORE_SCHEMAS_CHARS)!;
		// `bash` is declared in full, `archive` is not active, `gone` is not declared.
		expect(restored.tools).toEqual(["mcp__octocode__localSearch", "web"]);
		expect(restored.omitted).toEqual([]);
		expect(restored.content).toMatch(/^\[After compaction\]/);
		expect(restored.content).toContain(`mcp__octocode__localSearch\n${JSON.stringify(serverSchema)}`);
		expect(restored.content).toContain(`web\n${JSON.stringify(web.validationParameters)}`);
		// A schema that does not fit is left out whole and named; the next one that fits still comes back.
		const tight = restoredSchemas(declared, active, called, restored.content.length - 10)!;
		expect(tight.tools).toEqual(["mcp__octocode__localSearch"]);
		expect(tight.omitted).toEqual(["web"]);
		expect(tight.content).not.toContain('"op"');
		expect(restoredSchemas(declared, active, ["bash", "gone"], RESTORE_SCHEMAS_CHARS)).toBeUndefined();
		expect(restoredSchemas(declared, active, called, 50)).toBeUndefined();
	});

	it("sends one hidden message after a compaction and does not repeat schemas the kept context still shows", () => {
		const web = withNativeDeferral(settings(DEFERRED), nativeTool("web") as never);
		const search = mcpTool("mcp__octocode__localSearch", true);
		const sent: Array<{ message: Record<string, unknown>; options: unknown }> = [];
		const api = asSetup({
			getAllTools: () => [web, search] as never,
			getActiveTools: () => ["web", "mcp__octocode__localSearch"],
			sendMessage: (message: Record<string, unknown>, options: unknown) => void sent.push({ message, options }),
		});
		const context: unknown[] = [];
		const branch = [call("web"), call("mcp__octocode__localSearch")];
		const ctx = {
			model: { contextWindow: 200_000 },
			sessionManager: {
				getBranch: () => branch.map((message) => ({ type: "message", message })),
				buildSessionProjection: () => ({
					entries: context.map((message) => ({ sourceEntry: { id: "e" }, messages: [message] })),
				}),
			},
		} as never;
		expect(restoreDeferredSchemas(api as never, ctx)).toEqual(["mcp__octocode__localSearch", "web"]);
		expect(sent).toHaveLength(1);
		expect(sent[0].message).toMatchObject({
			customType: RESTORED_SCHEMAS_TYPE,
			display: false,
			details: { tools: ["mcp__octocode__localSearch", "web"] },
		});
		expect(sent[0].options).toEqual({ triggerTurn: false });
		// The next compaction kept that message in its tail: nothing is sent again until another deferred tool is called.
		context.push({ role: "custom", ...sent[0].message });
		expect(restoreDeferredSchemas(api as never, ctx)).toEqual([]);
		expect(sent).toHaveLength(1);
		// A session that called no deferred tool gets no message.
		branch.splice(0, branch.length, call("bash"));
		context.length = 0;
		expect(restoreDeferredSchemas(api as never, ctx)).toEqual([]);
		// A small window lowers the budget: a schema that no longer fits is not cut.
		branch.splice(0, branch.length, call("web"));
		expect(
			restoreDeferredSchemas(api as never, { ...(ctx as object), model: { contextWindow: 1000 } } as never),
		).toEqual([]);
		expect(sent).toHaveLength(1);
	});
});
