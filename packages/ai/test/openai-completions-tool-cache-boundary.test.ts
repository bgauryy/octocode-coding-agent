import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "../src/api/ai-sdk/openai-wire-types.ts";
import { applyAnthropicCacheControl, takeUnmarkedClaudeNotice } from "../src/api/openai-completions/cache-control.ts";

/**
 * Anthropic-format markers on Chat Completions (OpenRouter Claude, a gateway with `cacheControlFormat: "anthropic"`):
 * the tool marker at the end of the tools every role shares (`toolCacheBoundary`), as in the Anthropic adapter
 * (`anthropic-cache-breakpoint-matrix.test.ts`), and the one-time notice for a Claude model sent without markers.
 */

const control = { type: "ephemeral" as const, ttl: "1h" };
const history = { type: "ephemeral" as const };
const fn = (name: string): ChatCompletionTool => ({ type: "function", function: { name, description: name } });
const blocks = { cached: ["Base instructions", "Project context"], volatile: "Today" };

function request(tools: string[], split = true) {
	const messages: ChatCompletionMessageParam[] = [
		{ role: "system", content: split ? "Base instructionsProject contextToday" : "Base instructions" },
		{ role: "user", content: "task" },
	];
	return { messages, tools: tools.map(fn) };
}

const marked = (tools: ChatCompletionTool[]) =>
	tools.flatMap((tool) => ("cache_control" in tool && tool.type === "function" ? [tool.function.name] : []));
const systemMarks = (messages: ChatCompletionMessageParam[]) => {
	const content = messages[0].content;
	return Array.isArray(content) ? content.map((part) => "cache_control" in part) : [];
};
const count = (value: unknown) => JSON.stringify(value).split('"cache_control"').length - 1;

describe("Chat Completions Anthropic-format tool cache boundary", () => {
	it("gives two roles the same bytes and marker up to the end of their shared tools", () => {
		const a = request(["read", "grep", "agent"]);
		const b = request(["read", "grep", "skill"]);
		applyAnthropicCacheControl(a.messages, a.tools, history, control, blocks, "agent");
		applyAnthropicCacheControl(b.messages, b.tools, history, control, blocks, "skill");
		expect(marked(a.tools)).toEqual(["grep"]);
		expect(JSON.stringify(a.tools.slice(0, 2))).toBe(JSON.stringify(b.tools.slice(0, 2)));
		expect(JSON.stringify(a.tools)).not.toBe(JSON.stringify(b.tools));
		// The shared-tool marker takes the base block's slot: four markers at most.
		expect(systemMarks(a.messages)).toEqual([false, true, false]);
		expect(count(a)).toBeLessThanOrEqual(4);
	});

	it("keeps the base block's marker beside the shared-tool marker when the prompt is one block", () => {
		const one = request(["read", "agent"], false);
		applyAnthropicCacheControl(one.messages, one.tools, history, control, undefined, "agent");
		expect(marked(one.tools)).toEqual(["read"]);
		expect(systemMarks(one.messages)).toEqual([true]);
	});

	it("ignores a tool boundary that names the first tool or no tool, and needs instruction caching", () => {
		for (const boundary of ["read", "missing", undefined]) {
			const one = request(["read", "agent"], false);
			applyAnthropicCacheControl(one.messages, one.tools, history, control, undefined, boundary);
			expect(marked(one.tools)).toEqual(["agent"]);
		}
		const off = request(["read", "grep", "agent"]);
		applyAnthropicCacheControl(off.messages, off.tools, history, undefined, blocks, "agent");
		expect(marked(off.tools)).toEqual([]);
	});
});

describe("Claude on Chat Completions without cache markers", () => {
	const claude = { provider: "litellm", id: "claude-sonnet-4-5", name: "claude-sonnet-4-5" };

	it("tells the user once per model how to turn markers on", () => {
		const notice = takeUnmarkedClaudeNotice(claude, {}, "long");
		expect(notice).toMatchObject({ type: "cache_unavailable", details: { reason: "no_cache_markers" } });
		expect(String(notice?.details?.fix)).toContain("cacheControlFormat");
		expect(takeUnmarkedClaudeNotice(claude, {}, "long")).toBeUndefined();
		// An alias that names Claude only in its display name counts too.
		expect(
			takeUnmarkedClaudeNotice({ provider: "proxy", id: "sonnet", name: "Claude Sonnet" }, {}, "short"),
		).toBeDefined();
	});

	it("says nothing with markers on, caching off or a model that is not Claude", () => {
		const other = { ...claude, provider: "other-gateway" };
		expect(takeUnmarkedClaudeNotice(other, { cacheControlFormat: "anthropic" }, "long")).toBeUndefined();
		expect(takeUnmarkedClaudeNotice(other, {}, "none")).toBeUndefined();
		expect(takeUnmarkedClaudeNotice({ provider: "x", id: "gpt-5.5", name: "GPT-5.5" }, {}, "long")).toBeUndefined();
		// Not consumed by the silent calls above.
		expect(takeUnmarkedClaudeNotice(other, {}, "long")).toBeDefined();
	});
});
