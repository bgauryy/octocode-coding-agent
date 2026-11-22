import { describe, expect, it } from "vitest";
import { childCacheLabel, noteChildCache } from "../../src/octocode/subagents/cache-monitor.ts";
import { renderAgentResult } from "../../src/octocode/subagents/render.ts";
import type { RunDetails } from "../../src/octocode/subagents/run-types.ts";
import { rendered, theme } from "./fake-host.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { childPromptCacheKey, prefixKey } from "../../src/octocode/subagents/task-skills.ts";

describe("child cache monitoring and affinity", () => {
	it("shows the latest message's reads and writes while running and the conversation rate when finished", () => {
		const cache = noteChildCache(noteChildCache(undefined, { usage: { input: 0, cacheWrite: 4000 } }), {
			usage: { input: 1000, cacheRead: 4000 },
		})!;
		const details: RunDetails = {
			id: "child-a",
			profile: "researcher",
			goal: "audit",
			status: "running",
			toolCalls: 0,
			activity: [],
			input: 9000,
			cacheRead: 4000,
			output: 100,
			cost: 0.01,
			unpriced: false,
			startedAt: 0,
			cache,
		};
		const result = { content: [{ type: "text" as const, text: "working" }], details };
		expect(
			rendered(renderAgentResult(result, { isPartial: true, expanded: true }, theme, { expanded: true })),
		).toContain("Last request cache: 80% cached · 4k read · 0 written");
		expect(
			rendered(
				renderAgentResult(
					{ ...result, details: { ...details, status: "done" } },
					{ isPartial: false, expanded: true },
					theme,
					{ expanded: true },
				),
			),
		).toContain("conversation cache: 44% cached · 4k read · 4k written");
		expect(childCacheLabel({ promptTokens: 0, cacheRead: 0, cacheWrite: 0 })).toContain("n/a cached");
	});
	it("separates prefixes that differ in tools, lean or read-only mode, or added MCP servers", () => {
		const base = prefixKey("researcher", "openai/model", { tools: "+file,+agent" });
		expect(prefixKey("researcher", "openai/model", { tools: "+file,+agent" })).toBe(base);
		expect(prefixKey("researcher", "openai/model", { tools: "+file" })).not.toBe(base);
		expect(prefixKey("researcher", "openai/model", { tools: "+file,+agent", lean: true })).not.toBe(base);
		expect(prefixKey("researcher", "openai/model", { tools: "+file,+agent", readOnly: true })).not.toBe(base);
		expect(prefixKey("researcher", "openai/model", { tools: "+file,+agent", mcpServers: ["x"] })).not.toBe(base);
		// Server order does not matter; the same set is the same prefix.
		expect(prefixKey("researcher", "openai/model", { tools: "+file,+agent", mcpServers: ["b", "a"] })).toBe(
			prefixKey("researcher", "openai/model", { tools: "+file,+agent", mcpServers: ["a", "b"] }),
		);
		expect(base).not.toContain("+file");
	});
	it("groups children by prefix, across parents, without exposing task or session identifiers", () => {
		const prefix = prefixKey("researcher", "openai/model");
		const key = childPromptCacheKey(prefix);
		expect(key).toHaveLength(63);
		expect(key).not.toContain("researcher");
		// One prefix is one group whichever session launched the child: a new parent's children read what earlier ones wrote.
		expect(childPromptCacheKey(prefix)).toBe(key);
		expect(childPromptCacheKey(prefixKey("coder", "openai/model"))).not.toBe(key);
		const env = { OCTOCODE_PROMPT_CACHE_KEY: "old" };
		expect(subagentProcessEnv(undefined, env, { id: "child-a", promptCacheKey: key }).OCTOCODE_PROMPT_CACHE_KEY).toBe(
			key,
		);
		expect(subagentProcessEnv(undefined, env, { id: "child-b", promptCacheKey: key }).OCTOCODE_PROMPT_CACHE_KEY).toBe(
			key,
		);
		expect(subagentProcessEnv(undefined, env, { id: "child-c" }).OCTOCODE_PROMPT_CACHE_KEY).toBeUndefined();
	});
	it("records every reply's prompt buckets and replaces the latest request without mutating earlier updates", () => {
		const first = noteChildCache(undefined, { usage: { input: 50, cacheRead: 0, cacheWrite: 4000 } });
		const second = noteChildCache(first, {
			usage: { input: 100, cacheRead: 4000, cacheWrite: 500 },
			diagnostics: [{ type: "cache_miss", details: { reason: "tools_changed" } }],
		});
		expect(first?.latest).toEqual({ promptTokens: 4050, cacheRead: 0, cacheWrite: 4000 });
		expect(second).toEqual({
			requests: 2,
			promptTokens: 8650,
			cacheRead: 4000,
			cacheWrite: 4500,
			latest: { promptTokens: 4600, cacheRead: 4000, cacheWrite: 500, reason: "tools_changed" },
		});
		expect(noteChildCache(second, {})).toBe(second);
		expect(noteChildCache(second, { usage: { input: 2000 } })?.latest).toEqual({
			promptTokens: 2000,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});
});
