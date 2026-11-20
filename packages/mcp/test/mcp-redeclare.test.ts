import { join } from "node:path";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import type { McpServerEntry } from "../src/config.ts";
import { redeclaresInPlace } from "../src/redeclare.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

/**
 * A deferred tool is declared in full after its first call where the model's transport replaces a declaration in
 * place, and stays thin elsewhere. Either way the tool list and instruction blocks first sent are never rewritten.
 */
const echo = join(import.meta.dirname, "../../coding-agent/test/octocode/fixtures/echo-mcp.mjs");
const SHOUT = "mcp__docs__shout";
const hosts: ReturnType<typeof mcpHost>[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.close()));
	vi.unstubAllEnvs();
});

const modelBase = {
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};
/** Anthropic with native tool changes: a later definition under the same name is a `tool_addition` block. */
const native: Model<Api> = {
	...modelBase,
	id: "claude-native",
	name: "Claude native",
	api: "anthropic-messages",
	provider: "anthropic",
	compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};
/** The same transport without them: only the request's tool list exists. */
const plain: Model<Api> = {
	...native,
	id: "claude-plain",
	compat: { supportsMidConvoSystemMessages: true },
};

const entry: McpServerEntry = {
	name: "docs",
	config: { command: "echo", description: "docs purpose line" },
	source: "test",
};

async function session(model: Model<Api>, transcript: Message[] = []) {
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp());
	const h = mcpHost({
		servers: [entry],
		prepareLaunch: (launched) => ({
			...launched,
			config: { ...launched.config, command: process.execPath, args: [echo] },
		}),
		presentation: "declared",
		exposure: "recent",
		cwd: tmp(),
	});
	h.api.tools.getActive = () =>
		[...h.tools.values()].filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name);
	hosts.push(h);
	const ctx = {
		...h.ctx,
		model,
		sessionManager: { buildSessionProjection: () => ({ messages: transcript }) },
	} as unknown as typeof h.ctx;
	await h.start(ctx);
	const mcps = async () => (await h.prompt(ctx)).mcps ?? "";
	const declaration = (): Tool => toToolDeclaration(h.tools.get(SHOUT) as Tool);
	const called = (isError = false) => h.fire("tool_execution_end", { toolName: SHOUT, isError }, ctx);
	return { h, mcps, declaration, called };
}

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

/** The transcript as the agent loop writes it: the first declarations, then one change message when they differ. */
function transcriptOf(mcps: string, before: Tool, after: Tool): { first: Message[]; later: Message[] } {
	const first: Message[] = [
		{ role: "system", content: `base prompt\n${mcps}`, toolsAdded: [before], timestamp: 0 },
		{ role: "user", content: "shout hi", timestamp: 1 },
	];
	const changes = getToolStateChanges(getCurrentTools(first), [after]);
	const changed = changes.toolsAdded.length > 0 || changes.toolsRemoved.length > 0;
	const update: Message[] = changed ? [{ role: "system", content: "", ...changes, timestamp: 2 }] : [];
	return { first, later: [...first, ...update, { role: "user", content: "again", timestamp: 3 }] };
}

const additions = (payload: Awaited<ReturnType<typeof payloadOf>>) =>
	payload.messages.flatMap((message) =>
		Array.isArray(message.content)
			? (message.content as Array<{ type: string; tool?: { definition?: { name?: string } } }>).filter(
					(block) => block.type === "tool_addition",
				)
			: [],
	);

describe("which transports get a deferred tool in full after its first call", () => {
	it("only one that replaces a declaration in place", () => {
		expect(redeclaresInPlace(native)).toBe(true);
		expect(redeclaresInPlace(plain)).toBe(false);
		const responses = { ...modelBase, id: "gpt", name: "GPT", provider: "openai", api: "openai-responses" as const };
		const base = { supportsMidConvoSystemMessages: true };
		expect(redeclaresInPlace({ ...responses, compat: { ...base, supportsAdditionalTools: true } })).toBe(true);
		// Tool search only adds new names: a second definition of a declared name would resend the tool list.
		expect(redeclaresInPlace({ ...responses, compat: { ...base, supportsToolSearch: true } })).toBe(false);
		expect(
			redeclaresInPlace({
				...responses,
				api: "openai-completions",
				compat: { ...base, supportsMidConvoToolAdditions: true },
			}),
		).toBe(false);
		expect(redeclaresInPlace({ ...responses, api: "google-generative-ai", compat: base })).toBe(false);
		expect(redeclaresInPlace(undefined)).toBe(false);
		expect(redeclaresInPlace({ inputLimits: {} })).toBe(false);
	});
});

describe("a deferred tool after its first call", () => {
	it("is declared in full once, in place, on a transport with native tool changes", async () => {
		const s = await session(native);
		const block = await s.mcps();
		const thin = s.declaration();
		expect(block).toContain("\n- shout\n");
		expect(thin.parameters).toMatchObject({ additionalProperties: true });

		await s.called();
		// The block of the prompt is the same text; only the declaration changed, to the server's own schema.
		expect(await s.mcps()).toBe(block);
		const full = s.declaration();
		expect(full.parameters).toMatchObject({ required: ["text"] });
		expect(full.parameters).not.toHaveProperty("additionalProperties", true);
		expect(full.description).toBe(thin.description);

		// A later call changes nothing more: the definition is added once.
		const definition = s.h.tools.get(SHOUT);
		await s.called();
		await s.mcps();
		expect(s.h.tools.get(SHOUT)).toBe(definition);

		const { first, later } = transcriptOf(block, thin, full);
		const before = await payloadOf(native, first);
		const after = await payloadOf(native, later);
		// The cached prefix: the request's tool list and instruction blocks are byte-identical.
		expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
		expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
		expect(before.tools?.find((tool) => tool.name === SHOUT)?.input_schema).toMatchObject({
			additionalProperties: true,
		});
		expect(additions(before)).toEqual([]);
		const added = additions(after);
		expect(added).toHaveLength(1);
		expect(added[0].tool?.definition).toMatchObject({ name: SHOUT, input_schema: { required: ["text"] } });
		// Compaction and resume read the tools from the transcript, which now declares the full form.
		expect(getCurrentTools(later).find((tool) => tool.name === SHOUT)).toEqual(full);
	});

	it("is declared in full after a failed call too", async () => {
		const s = await session(native);
		await s.mcps();
		await s.called(true);
		await s.mcps();
		expect(s.declaration().parameters).toMatchObject({ required: ["text"] });
	});

	it("stays thin on a transport without them, so the tool list first sent is never rewritten", async () => {
		const s = await session(plain);
		const block = await s.mcps();
		const thin = s.declaration();
		const definition = s.h.tools.get(SHOUT);

		await s.called();
		expect(await s.mcps()).toBe(block);
		expect(s.h.tools.get(SHOUT)).toBe(definition);
		// The schema still arrives as a tool result: a refused call shows it.
		expect(definition.validationHint?.({ envelope: false, properties: ["text"] })).toContain('"required":["text"]');

		const { first, later } = transcriptOf(block, thin, s.declaration());
		expect(later.filter((message) => message.role === "system")).toHaveLength(1);
		const before = await payloadOf(plain, first);
		const after = await payloadOf(plain, later);
		expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
		expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
		expect(additions(after)).toEqual([]);
	});

	it("is registered in full again by a resumed session whose transcript declares it in full", async () => {
		const loaded = await session(native);
		const block = await loaded.mcps();
		const thin = loaded.declaration();
		await loaded.called();
		await loaded.mcps();
		const full = loaded.declaration();
		const { later } = transcriptOf(block, thin, full);

		// The transcript decides, whatever the model: no call in this session, and no change to declare.
		const resumed = await session(plain, later);
		expect(await resumed.mcps()).toBe(block);
		expect(resumed.declaration()).toEqual(full);
		expect(getToolStateChanges(getCurrentTools(later), [resumed.declaration()])).toEqual({
			toolsAdded: [],
			toolsRemoved: [],
		});

		// A transcript that declares the thin form resumes thin.
		const cold = await session(native, transcriptOf(block, thin, thin).later);
		await cold.mcps();
		expect(cold.declaration()).toEqual(thin);
	});
});
