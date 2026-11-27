import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aiSdkAdapter } from "../../examples/adapters/ai-sdk.ts";
import type { AgentAdapter } from "../../src/adapter.ts";
import { claudeCodeAdapter, cliMissing } from "../../src/adapters/claude-code/index.ts";
import { codexAdapter } from "../../src/adapters/codex/index.ts";
import { startGateway, type Gateway } from "../../src/gateway.ts";
import { mockMcp } from "../../src/mcp.ts";
import type { Pricing } from "../../src/policy.ts";
import { spentUsd } from "../../src/policy.ts";
import type { Forward } from "../../src/upstream.ts";
import { searchTool } from "../helpers.ts";

/*
 * Forwarding against real providers, one run per wire: a real harness, a real model, a mock MCP tool the model must
 * call, and the answer it must read back. Costs money: runs only with TESTKIT_LIVE=1, at most 8 requests and $0.50
 * per case. Providers come from the user's models.json (keys stay in memory, never printed).
 */

const LIVE = process.env.TESTKIT_LIVE === "1";
const MODELS_JSON = process.env.TESTKIT_LIVE_MODELS_JSON ?? join(homedir(), ".octocode", "octocodecode", "models.json");
const ANTHROPIC = {
	id: "anthropic-custom",
	model: "claude-haiku-5-5",
	pricing: { input: 0.1, cacheRead: 0.01, output: 0.5 },
};
const OPENAI = { id: "openai-custom", model: "gpt-6.1-terra", pricing: { input: 1, cacheRead: 0.05, output: 5 } };
/** This model takes function tools on chat completions only without reasoning (its own 400 says so). */
const CHAT_BODY = { reasoning_effort: "none" };
const PROMPT =
	'Call the docs search tool exactly once with the query "cache". Then reply with only the file path it returned.';

/** A `models.json` apiKey as Octocode resolves literals and `$NAME`; `!command` keys are not run. */
function provider(id: string): { baseUrl: string; key: string } | string {
	if (!existsSync(MODELS_JSON)) return `no ${MODELS_JSON}`;
	const p = (
		JSON.parse(readFileSync(MODELS_JSON, "utf8")) as {
			providers?: Record<string, { baseUrl?: string; apiKey?: unknown }>;
		}
	).providers?.[id];
	const raw = p?.apiKey;
	if (!p?.baseUrl || typeof raw !== "string" || !raw || raw.startsWith("!"))
		return `provider ${id}: no baseUrl or usable apiKey`;
	const ref = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(raw);
	const key = ref ? process.env[ref[1]] : raw;
	return key ? { baseUrl: p.baseUrl, key } : `provider ${id}: ${raw} is not set`;
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const c of closers.splice(0).reverse()) await c();
});

async function liveRun(
	forward: Forward,
	pricing: Pricing,
	adapter: AgentAdapter,
): Promise<{ gw: Gateway; result: unknown }> {
	const gw = await startGateway({ forward, cassette: { mode: "off" }, caps: { maxRequests: 8, maxUsd: 0.5, pricing } });
	closers.push(() => gw.close());
	const docs = mockMcp({ name: "docs", trace: gw.trace, tools: [searchTool] });
	docs.tool("search").returns("docs/cache.md");
	closers.push(() => docs.close());
	const session = await adapter.start({ gatewayUrl: gw.url, mcpUrls: { docs: await docs.listen() } });
	closers.push(() => session.close());
	return { gw, result: await session.run(PROMPT) };
}

function report(label: string, gw: Gateway): void {
	const reqs = gw.trace.requests;
	console.info(
		`[live:${label}] ${JSON.stringify({
			requests: reqs.length,
			models: [...new Set(reqs.map((r) => r.model))],
			promptTokens: reqs.reduce((n, r) => n + (r.usage?.promptTokens ?? 0), 0),
			cachedTokens: reqs.reduce((n, r) => n + (r.usage?.cachedTokens ?? 0), 0),
			completionTokens: reqs.reduce((n, r) => n + (r.usage?.completionTokens ?? 0), 0),
			usd: Number(spentUsd(gw.trace).toFixed(4)),
			toolCalls: gw.trace.of("model_tool_call").map((e) => e.name),
			answer: String(gw.trace.of("answer").at(-1)?.data ?? "").slice(0, 120),
			errors: gw.errors,
		})}`,
	);
}

/** The round trip every wire must carry: the model called the tool, the gateway saw real usage, and it read the answer. */
function expectRoundTrip(gw: Gateway): void {
	expect(gw.errors).toEqual([]);
	expect(gw.trace.cut, "no cap stopped the run").toBe(false);
	expect(gw.trace).toHaveCalledMcp("docs", "search", { before: "answer" });
	expect(gw.trace.requests.every((r) => r.usage && !r.usage.estimated)).toBe(true);
	expect(String(gw.trace.of("answer").at(-1)?.data)).toContain("docs/cache.md");
}

describe("forwarding to real providers", () => {
	it("Anthropic Messages, as sent: Claude Code to Claude Haiku", async (ctx) => {
		if (!LIVE) return ctx.skip("live: set TESTKIT_LIVE=1 (costs money)");
		const p = provider(ANTHROPIC.id);
		const missing = cliMissing("claude") ?? (typeof p === "string" ? p : undefined);
		if (missing || typeof p === "string") return ctx.skip(missing ?? "no provider");
		const forward: Forward = {
			baseUrl: p.baseUrl,
			api: "anthropic",
			key: p.key,
			model: ANTHROPIC.model,
			timeoutMs: 120_000,
		};
		const { gw } = await liveRun(forward, ANTHROPIC.pricing, claudeCodeAdapter());
		report("anthropic", gw);
		expectRoundTrip(gw);
	}, 300_000);

	it("OpenAI Responses, as sent: Codex to GPT", async (ctx) => {
		if (!LIVE) return ctx.skip("live: set TESTKIT_LIVE=1 (costs money)");
		const p = provider(OPENAI.id);
		const missing = cliMissing("codex") ?? (typeof p === "string" ? p : undefined);
		if (missing || typeof p === "string") return ctx.skip(missing ?? "no provider");
		const forward: Forward = {
			baseUrl: p.baseUrl,
			api: "responses",
			key: p.key,
			model: OPENAI.model,
			timeoutMs: 120_000,
		};
		const { gw } = await liveRun(forward, OPENAI.pricing, codexAdapter());
		report("responses", gw);
		expectRoundTrip(gw);
	}, 300_000);

	it("OpenAI chat completions, as sent: an AI SDK agent to GPT", async (ctx) => {
		if (!LIVE) return ctx.skip("live: set TESTKIT_LIVE=1 (costs money)");
		const p = provider(OPENAI.id);
		if (typeof p === "string") return ctx.skip(p);
		const forward: Forward = {
			baseUrl: p.baseUrl,
			api: "openai",
			key: p.key,
			model: OPENAI.model,
			timeoutMs: 120_000,
			body: CHAT_BODY,
		};
		const { gw } = await liveRun(forward, OPENAI.pricing, aiSdkAdapter({ wire: "openai" }));
		report("chat", gw);
		expectRoundTrip(gw);
	}, 300_000);

	it("Anthropic client to a chat upstream, translated: Claude Code to GPT", async (ctx) => {
		if (!LIVE) return ctx.skip("live: set TESTKIT_LIVE=1 (costs money)");
		const p = provider(OPENAI.id);
		const missing = cliMissing("claude") ?? (typeof p === "string" ? p : undefined);
		if (missing || typeof p === "string") return ctx.skip(missing ?? "no provider");
		const forward: Forward = {
			baseUrl: p.baseUrl,
			api: "openai",
			key: p.key,
			model: OPENAI.model,
			timeoutMs: 120_000,
			body: CHAT_BODY,
		};
		const { gw } = await liveRun(forward, OPENAI.pricing, claudeCodeAdapter());
		report("anthropic-to-chat", gw);
		expectRoundTrip(gw);
	}, 300_000);
});
