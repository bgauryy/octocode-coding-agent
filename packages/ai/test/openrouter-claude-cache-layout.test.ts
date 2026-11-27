import { describe, expect, it } from "vitest";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Message, TranscriptContext } from "../src/types.ts";
import {
	assistant,
	capture,
	grepTool,
	readTool,
	toolCall,
	toolResult,
	transcript,
	user,
} from "./anthropic-cache-fixtures.ts";
import { captureCompletionsParams } from "./capture-completions-payload.ts";

/** OpenRouter Claude (Chat Completions, Anthropic-format markers) places markers where the Anthropic adapter does. */

const anthropic = getBuiltinModel("anthropic", "claude-haiku-4-5");
const openrouter = getBuiltinModel("openrouter", "~anthropic/claude-opus-latest");
if (openrouter.api !== "openai-completions") throw new Error("OpenRouter Claude must use Chat Completions");

const SECTIONS = {
	docs: "<docs>stable docs</docs>",
	session: "<session>s</session>",
	project_context: "<project>p</project>",
	today: "<today>d</today>",
};
const boundaries = {
	instructionCacheBoundary: "session",
	instructionWorkspaceBoundary: "project_context",
	instructionVolatileBoundary: "today",
	toolCacheBoundary: "grep",
};

function context(messages: Message[]): TranscriptContext {
	const base = transcript(messages, [readTool, grepTool, { ...readTool, name: "agent" }]);
	const [head, ...rest] = base.messages;
	return { messages: [{ ...head, sections: SECTIONS }, ...rest] } as TranscriptContext;
}

const conversations: Record<string, (m: typeof anthropic) => Message[]> = {
	"one user turn": () => [user("task")],
	"tool turn": (m) => [user("task"), assistant(m, [toolCall("c1")]), toolResult("c1")],
};

type Part = { cache_control?: unknown; text?: string };
const flags = (content: unknown): boolean[] | undefined =>
	Array.isArray(content) ? (content as Part[]).map((part) => part.cache_control !== undefined) : undefined;

describe("OpenRouter Claude cache marker layout", () => {
	it.each(Object.keys(conversations))("matches Anthropic for %s", async (name) => {
		const messages = conversations[name](anthropic);
		const a = await capture(anthropic, context(messages), { cacheRetention: "short", ...boundaries });
		const o = await captureCompletionsParams(openrouter, context(messages), { cacheRetention: "short", ...boundaries });
		const tools = (o.tools ?? []).map((tool) => "cache_control" in tool);
		expect(tools).toEqual((a.tools ?? []).slice(0, tools.length).map((tool) => tool.cache_control !== undefined));
		const systems = o.messages.filter((m) => m.role === "system");
		const orSystem = systems.flatMap((m) => flags(m.content) ?? []);
		const anSystem = (a.system ?? []).map((block) => block.cache_control !== undefined);
		expect(orSystem).toEqual(anSystem);
		const orHistory = o.messages
			.filter((m) => m.role !== "system")
			.map((m) => flags(m.content)?.some(Boolean) ?? false);
		const anHistory = a.messages.map((m) =>
			Array.isArray(m.content) ? m.content.some((b) => b.cache_control) : false,
		);
		expect(orHistory.filter(Boolean)).toHaveLength(anHistory.filter(Boolean).length);
		expect(JSON.stringify(o).split('"cache_control"').length - 1).toBe(
			JSON.stringify(a).split('"cache_control"').length - 1,
		);
	});

	it("leaves the workspace block marked only when a slot remains", async () => {
		const messages = conversations["tool turn"](anthropic);
		const o = await captureCompletionsParams(openrouter, context(messages), { cacheRetention: "short", ...boundaries });
		const system = flags(o.messages[0].content);
		// base, session, workspace cached blocks + volatile: tools boundary marker on `read` + base dropped, history takes 2, workspace unmarked.
		expect(system).toEqual([false, true, false, false]);
		expect((o.tools ?? []).map((tool) => "cache_control" in tool)).toEqual([true, false, false]);
	});
});

describe("OpenRouter Claude parity for a managed-effort Anthropic model", () => {
	const opus = getBuiltinModel("anthropic", "claude-opus-5-5");
	const text = (value: string) => [{ type: "text" as const, text: value }];

	// The trailing empty effort-update system message is not a turn: it must not take a history slot from the workspace block.
	it.each([
		["assistant-final", (m: typeof opus) => [user("task"), assistant(m, text("done"))]],
		[
			"assistant-final after a tool turn",
			(m: typeof opus) => [user("task"), assistant(m, [toolCall("c1")]), toolResult("c1"), assistant(m, text("done"))],
		],
	] as const)("marks the same tools and system blocks as OpenRouter for %s", async (_name, build) => {
		const messages = build(opus);
		const a = await capture(opus, context(messages), { cacheRetention: "short", ...boundaries });
		const o = await captureCompletionsParams(openrouter, context(messages), { cacheRetention: "short", ...boundaries });
		const orSystem = o.messages.filter((m) => m.role === "system").flatMap((m) => flags(m.content) ?? []);
		expect((a.system ?? []).map((block) => block.cache_control !== undefined)).toEqual(orSystem);
		const tools = (o.tools ?? []).map((tool) => "cache_control" in tool);
		expect(tools).toEqual((a.tools ?? []).slice(0, tools.length).map((tool) => tool.cache_control !== undefined));
	});

	it("spends the same markers as OpenRouter for a user-final conversation", async () => {
		const messages = [user("task"), assistant(opus, text("done")), user("more")];
		const a = await capture(opus, context(messages), { cacheRetention: "short", ...boundaries });
		const o = await captureCompletionsParams(openrouter, context(messages), { cacheRetention: "short", ...boundaries });
		expect(JSON.stringify(a).split('"cache_control"').length - 1).toBe(
			JSON.stringify(o).split('"cache_control"').length - 1,
		);
	});
});
