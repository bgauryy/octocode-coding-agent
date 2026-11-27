import fs from "node:fs";
import { runToolCall } from "@octocodeai/octocode-agent-core";
import path from "node:path";
import {
	fauxAssistantMessage,
	type JsonObject,
	type KnownApi,
	type Model,
	type Tool,
	validateToolArguments,
} from "@octocodeai/octocode-ai";
import { streamSimple } from "@octocodeai/octocode-ai/compat";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/core/features/index.ts";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";
import { registerFileTool } from "../../src/octocode/native/tools/file/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { prepareChangeArguments } from "../../src/octocode/files/tool/queries.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

type FileTool = ToolDefinition<any, { outcomes: { ok: boolean }[] }> & {
	prepareArguments: typeof prepareChangeArguments;
};

function fileTool(): FileTool {
	const host = fakeHost();
	registerFileTool(host.api, new FileGuard(), fakePermission());
	return host.tools.get("file");
}

function context(cwd: string) {
	return Object.assign(fakeCtx({ cwd, hasUI: false }), {
		tools: [],
		executeTool: () => {
			throw new Error("Unexpected nested tool call");
		},
	});
}

/** Validate and prepare the registered tool just as the agent loop does. */
async function call(tool: FileTool, args: Record<string, unknown>, cwd: string) {
	const validated = validateToolArguments(
		tool,
		{
			type: "toolCall",
			id: "c",
			name: "file",
			arguments: args as JsonObject,
		},
		tool.prepareArguments,
	);
	return tool.execute("c", validated, undefined, undefined, context(cwd));
}

describe("file tool: a single flat change", () => {
	it("runs a call that is one change itself, as the one-item queries it means", async () => {
		const cwd = tmp();
		const result = await call(
			fileTool(),
			{ type: "write", path: "a.txt", content: "x", reason: "Create the file" },
			cwd,
		);
		expect(result.details.outcomes).toMatchObject([{ ok: true }]);
		expect(fs.readFileSync(path.join(cwd, "a.txt"), "utf8")).toBe("x");
	});

	it("executes the nullable operands a strict provider must send, preserving the provider transcript", async () => {
		const cwd = tmp();
		const file = fileTool();
		const tool = wrapToolDefinition(file, () => context(cwd));
		const query = { type: "write", path: "answer", reason: null, edits: null, fromAttachment: null, content: "42" };
		const args = { reason: "Save result", queries: [query], patch: null };
		const result = await runToolCall(
			{ type: "toolCall", id: "strict", name: "file", arguments: args },
			{
				tools: [tool],
				context: { tools: [tool], messages: [] },
				assistantMessage: fauxAssistantMessage("Save it"),
			},
		);
		expect(result.isError, JSON.stringify(result.result.content)).toBe(false);
		expect(fs.readFileSync(path.join(cwd, "answer"), "utf8")).toBe("42");
		expect(args.patch).toBeNull();
		expect(query.reason).toBeNull();
	});

	it("executes the strict provider's patch form when queries is null", async () => {
		const cwd = tmp();
		const patch = "*** Begin Patch\n*** Add File: answer\n+42\n*** End Patch";
		await call(fileTool(), { reason: "Save result", patch, queries: null }, cwd);
		expect(fs.readFileSync(path.join(cwd, "answer"), "utf8")).toBe("42\n");
	});

	it.each([
		{ type: "write" },
		{ type: "write", content: "surprise", edits: [{ oldText: "old", newText: "new" }] },
		{ type: "delete", content: "surprise" },
		{ type: "delete", fromAttachment: "a".repeat(64) },
		{ type: "delete", edits: [{ oldText: "old", newText: "new" }] },
	])("refuses invalid operands before changing the file ($type)", async (query) => {
		const cwd = tmp();
		const target = path.join(cwd, "keep.txt");
		const tool = fileTool();
		await call(tool, { reason: "Create fixture", type: "write", path: "keep.txt", content: "original" }, cwd);
		await expect(
			call(tool, { reason: "Apply one operation", queries: [{ path: "keep.txt", ...query }] }, cwd),
		).rejects.toThrow(/write takes|delete takes only/i);
		expect(fs.readFileSync(target, "utf8")).toBe("original");
	});

	it.each(["queries", "flat"])("recovers a malformed %s edit with the required edit operands", async (form) => {
		const cwd = tmp();
		const tool = fileTool();
		const name = "RFC.md";
		const file = path.join(cwd, name);
		const before = "[a](../../../../packages/a) [b](../../../../packages/b)";
		fs.writeFileSync(file, before);
		const malformed = { type: "edit", path: name, content: "", fromAttachment: "", reasons: {}, editsToApply: [] };
		const reason = "Fix both source links";
		const args = form === "flat" ? { reason, ...malformed } : { reason, queries: [malformed] };
		await expect(call(tool, args, cwd)).rejects.toThrow(/edits.*oldText.*newText/s);
		expect(fs.readFileSync(file, "utf8")).toBe(before);
		const edits = [{ oldText: "../../../../packages/", newText: "../../../packages/", replaceAll: true }];
		const result = await call(tool, { reason, queries: [{ type: "edit", path: name, edits }] }, cwd);
		expect(result.details.outcomes).toMatchObject([{ ok: true }]);
		expect(fs.readFileSync(file, "utf8")).toBe("[a](../../../packages/a) [b](../../../packages/b)");
	});

	it("takes the call's reason from its changes when every change has one, and still requires one otherwise", async () => {
		const cwd = tmp();
		const tool = fileTool();
		const result = await call(
			tool,
			{
				queries: [
					{ type: "write", path: "a.txt", content: "a", reason: "Add a" },
					{ type: "write", path: "b.txt", content: "b", reason: "Add b" },
				],
			},
			cwd,
		);
		expect(result.details.outcomes).toMatchObject([{ ok: true }, { ok: true }]);
		expect(tool.prepareArguments({ queries: [{ type: "delete", path: "a", reason: "x" }] })).toMatchObject({
			reason: "x",
		});
		await expect(
			call(
				tool,
				{
					queries: [
						{ type: "write", path: "c.txt", content: "c", reason: "Add c" },
						{ type: "write", path: "d.txt", content: "d" },
					],
				},
				cwd,
			),
		).rejects.toThrow(/reason/);
		expect(fs.existsSync(path.join(cwd, "c.txt"))).toBe(false);
	});

	it("keeps the call's reason on the wrapped change", () => {
		const prepared = fileTool().prepareArguments({ reason: "r", type: "delete", path: "b.txt" }) as {
			reason: string;
			queries: { reason: string; type: string; path: string }[];
		};
		expect(prepared.queries).toEqual([{ reason: "r", type: "delete", path: "b.txt" }]);
	});

	it("still refuses what is not unambiguously one change, naming the expected shape", async () => {
		const cwd = tmp();
		const tool = fileTool();
		const taught = /file takes either queries .* or patch .*not both/;
		// An unknown change type and a missing path are left as sent. A change beside a patch is the patch's call: the
		// change fields are not wrapped, so nothing is written, and an empty patch is an error.
		await expect(call(tool, { reason: "r", type: "copy", path: "a.txt" }, cwd)).rejects.toThrow(taught);
		await expect(call(tool, { reason: "r", type: "write", content: "x" }, cwd)).rejects.toThrow(taught);
		await expect(
			call(tool, { reason: "r", type: "write", path: "a.txt", patch: "*** Begin Patch\n*** End Patch" }, cwd),
		).rejects.toThrow(/Empty patch: it changes no file/);
		expect(fs.existsSync(path.join(cwd, "a.txt"))).toBe(false);
	});
});

// Key by API so a newly added chat transport needs its own wire-format check.
const fileRoutes = {
	"openai-completions": [
		"amazon-bedrock-models",
		"global.moonshotai.kimi-k3.1",
		"https://bedrock-runtime.eu-central-1.amazonaws.com/openai/v1",
	],
	"openai-responses": ["openai", "gpt-5", "https://api.openai.com/v1"],
	openresponses: ["openai", "gpt-5", "https://openresponses.fixture.test/v1"],
	"azure-openai-responses": ["azure", "test-deployment", "https://fixture.openai.azure.com/openai/v1"],
	"anthropic-messages": ["anthropic", "claude-sonnet-4-5", "https://api.anthropic.com"],
	"bedrock-converse-stream": [
		"amazon-bedrock",
		"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
		"https://bedrock-runtime.us-east-1.amazonaws.com",
	],
	"google-generative-ai": ["google", "gemini-2.5-flash", "https://generativelanguage.googleapis.com/v1beta"],
	"google-vertex": ["google-vertex", "gemini-2.5-flash", "https://aiplatform.googleapis.com"],
	"mistral-conversations": ["mistral", "devstral-medium-latest", "https://api.mistral.ai/v1"],
} satisfies Record<KnownApi, [string, string, string]>;

interface WireTools {
	tools?: {
		function?: { parameters: Tool["parameters"] };
		parameters?: Tool["parameters"];
		input_schema?: Tool["parameters"];
		functionDeclarations?: { parametersJsonSchema: Tool["parameters"] }[];
	}[];
	toolConfig?: { tools: { toolSpec: { inputSchema: { json: Tool["parameters"] } } }[] };
}

it.each(Object.keys(fileRoutes) as KnownApi[])(
	"preserves file and parameterless tool schemas on the %s wire",
	async (api) => {
		const [provider, id, baseUrl] = fileRoutes[api];
		const model: Model<KnownApi> = {
			api,
			id,
			name: id,
			provider,
			baseUrl,
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		let parameters: Tool["parameters"] | undefined;
		let parameterless: Tool["parameters"] | undefined;
		const result = await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Fix the links", timestamp: 0 }],
				tools: [
					{ ...fileTool(), description: "File changes" },
					{
						name: "status",
						description: "Show status",
						parameters: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			},
			{
				apiKey: "fixture",
				env: {},
				fetch: async () => {
					throw new Error("Unexpected network request");
				},
				onPayload: (body) => {
					const payload = body as WireTools;
					const schemaAt = (index: number) => {
						const entry = payload.tools?.[index];
						return (
							entry?.function?.parameters ??
							entry?.parameters ??
							entry?.input_schema ??
							payload.tools?.[0]?.functionDeclarations?.[index]?.parametersJsonSchema ??
							payload.toolConfig?.tools[index]?.toolSpec.inputSchema.json
						);
					};
					parameters = schemaAt(0);
					parameterless = schemaAt(1);
					throw new Error("Captured before network");
				},
			},
		).result();
		expect(result.errorMessage).toBe("Captured before network");
		expect(parameterless).toBeDefined();
		expect(
			validateToolArguments(
				{ name: "status", description: "", parameters: parameterless!, coerceArguments: false },
				{ type: "toolCall", name: "status", id: "status-call", arguments: {} },
			),
		).toEqual({});
		expect(parameters).toBeDefined();
		expect(JSON.stringify(parameters)).not.toContain('"oneOf"');
		const accepts = (query: JsonObject) =>
			validateToolArguments(
				{ name: "file", description: "", parameters: parameters!, coerceArguments: false },
				{ type: "toolCall", id: "c", name: "file", arguments: { reason: "Fix links", queries: [query] } },
			);
		const edits = [{ oldText: "a", newText: "b" }];
		const fromAttachment = "a".repeat(64);
		// The wire schema is one flat object (strict tool calling takes no object unions): it takes every valid operation,
		// and which operands go with which `type` is refused when the arguments are prepared, before validation.
		const prepared = (query: JsonObject) => prepareChangeArguments({ reason: "Fix links", queries: [query] });
		expect(() => accepts({ type: "edit", path: "r.md", edits })).not.toThrow();
		expect(() => prepared({ type: "edit", path: "r.md", fromAttachment, edits })).toThrow(/edits.*oldText.*newText/s);
		expect(() => accepts({ type: "write", path: "r.md", fromAttachment })).not.toThrow();
		expect(() => accepts({ type: "write", path: "r.md", content: "" })).not.toThrow();
		expect(() => prepared({ type: "write", path: "r.md", content: "", fromAttachment })).toThrow(
			"A write takes content or fromAttachment, one of them, not both.",
		);
		expect(() => accepts({ type: "delete", path: "r.md" })).not.toThrow();
		const valid: JsonObject[] = [
			{ type: "edit", path: "r.md", edits },
			{ type: "write", path: "r.md", fromAttachment },
			{ type: "write", path: "r.md", content: "" },
			{ type: "delete", path: "r.md" },
		];
		for (const query of valid) expect(() => prepared(query)).not.toThrow();
	},
);

describe("file tool result text", () => {
	it("returns the written source digest without an empty diagnostics line", async () => {
		const tool = fileTool();
		const cwd = fs.realpathSync(tmp());
		const result = (await call(tool, { reason: "r", type: "write", path: "a.txt", content: "x" }, cwd)) as unknown as {
			content: { text: string }[];
		};
		// A written file is known whole, so the line ends with the digest a following anchored edit names.
		expect(result.content[0].text).toBe(
			"1. OK write a.txt: wrote sourceSha256=2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
		);
	});
});
