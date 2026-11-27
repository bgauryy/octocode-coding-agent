import "../bundle.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { script } from "../../src/gateway.ts";
import { requireBundle } from "../guards/support.ts";
import { gateway, mcp, searchTool } from "../helpers.ts";
import { recordedUsage, runAgent, startRecordingProxy, type ProbeProvider, type ProbeRequest } from "./cache-probe.ts";

/**
 * Live prompt-cache probe of the real bundle on Anthropic Messages, OpenAI Responses and Google: one session of three
 * turns; turn 3 asks the model to stop the mock MCP server, so the request after that tool call carries a tool
 * change. A loopback proxy records each request's tool list, cache markers, tool-change carriers and the provider's
 * usage. Costs money: runs only with TESTKIT_LIVE=1, at most ~4 requests per provider.
 */

const LIVE = process.env.TESTKIT_LIVE === "1";
const BUNDLE = process.env.TESTKIT_OCTOCODE_AGENT_BUNDLE ?? "";
const MODELS_JSON = process.env.TESTKIT_LIVE_MODELS_JSON ?? join(homedir(), ".octocode", "octocodecode", "models.json");

/** Cheapest chat model per provider, by the shipped model data (USD per MTok input / cache read / cache write). */
const TARGETS = [
	{ id: "anthropic-custom", model: "claude-haiku-5-5", price: { input: 0.1, read: 0.01, write: 0.125, output: 0.5 } },
	{ id: "openai-custom", model: "gpt-6.1-terra", price: { input: 1, read: 0.05, write: 1.25, output: 5 } },
	{ id: "google-custom", model: "gemini-3.8-flash", price: { input: 0.75, read: 0.075, write: 0, output: 3.75 } },
] as const;

const PROMPTS = [
	"Reply with the single word ONE. Do not call any tool.",
	"Reply with the single word TWO. Do not call any tool.",
	'Call the `mcp` tool once with intent "stop", server "docs" and reason "probe". After it returns, reply with the single word THREE.',
];

/** Resolve a `models.json` apiKey the way Octocode does for literals and `$NAME`; `!command` keys are not run. */
function resolveKey(raw: unknown): string | undefined {
	if (typeof raw !== "string" || !raw || raw.startsWith("!")) return undefined;
	const ref = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(raw);
	return ref ? process.env[ref[1]] : raw;
}

function loadProvider(id: string, modelId: string): ProbeProvider | string {
	if (!existsSync(MODELS_JSON)) return `no ${MODELS_JSON}`;
	const cfg = JSON.parse(readFileSync(MODELS_JSON, "utf8")) as {
		providers?: Record<string, { baseUrl?: string; api?: string; apiKey?: unknown; models?: { id: string }[] }>;
	};
	const p = cfg.providers?.[id];
	if (!p?.baseUrl || !p.api) return `provider ${id} missing baseUrl/api`;
	const model = p.models?.find((m) => m.id === modelId);
	if (!model) return `provider ${id} lists no model ${modelId}`;
	const key = resolveKey(p.apiKey);
	if (!key) return `provider ${id}: no usable apiKey (literal or $NAME)`;
	return { id, api: p.api, upstreamBase: p.baseUrl, model: { ...model }, key };
}

const row = (r: ProbeRequest, i: number): Record<string, unknown> => ({
	req: i + 1,
	status: r.status,
	promptTotal: r.usage.promptTotal,
	uncached: r.usage.uncached,
	cacheRead: r.usage.cacheRead,
	cacheWrite: r.usage.cacheWrite,
	w5m: r.usage.write5m,
	w1h: r.usage.write1h,
	out: r.usage.output,
	tools: r.tools.length,
	toolsHash: r.toolsHash,
	sys: r.systemHash,
	items: r.items,
	carriers: r.toolChangeCarriers.join(","),
	markers: JSON.stringify(r.cacheMarkers),
});

async function probe(
	provider: ProbeProvider,
	bundle: string,
	opts: { prompts?: string[]; env?: Record<string, string>; withMcp?: boolean } = {},
): Promise<{ requests: ProbeRequest[]; run: Awaited<ReturnType<typeof runAgent>> }> {
	const proxy = await startRecordingProxy(provider.api, provider.upstreamBase);
	const gw = await gateway({ responder: script([]) });
	const docs = mcp(gw, "docs", [searchTool]);
	const withMcp = opts.withMcp ?? true;
	try {
		const run = await runAgent({
			bundle,
			provider,
			baseUrl: proxy.url,
			prompts: opts.prompts ?? PROMPTS,
			mcpServers: withMcp ? { docs: await docs.listen() } : undefined,
			thinking: "off",
			env: opts.env,
		});
		return { requests: proxy.requests.filter((r) => r.path && r.bodyBytes > 0), run };
	} finally {
		await proxy.close();
	}
}

describe("provider prompt cache through the real bundle", () => {
	it("probe harness: the proxy records every request and a stopped server's tools are held to the next span (scripted)", async (ctx) => {
		requireBundle(ctx);
		const upstream = await gateway({
			responder: script([
				{ text: "ONE" },
				{ text: "TWO" },
				{ toolCalls: [{ name: "mcp", args: { intent: "stop", server: "docs", reason: "probe" } }] },
				{ text: "THREE" },
			]),
		});
		const provider: ProbeProvider = {
			id: "testkit",
			api: "openai-completions",
			upstreamBase: `${upstream.url}/v1`,
			model: { id: "scripted" },
			key: "no-key",
		};
		const { requests, run } = await probe(provider, BUNDLE);
		console.info(`[live-cache:scripted] ${JSON.stringify(requests.map(row))}`);
		expect(run.exitCode, run.stderr.slice(-2000)).toBe(0);
		expect(requests).toHaveLength(4);
		expect(requests[2].tools).toContain("mcp__docs__search");
		// openai-completions cannot change tools in place: the stopped server's tools stay declared (the model is told they
		// are off) until the next span, so the cached tool prefix is unchanged.
		expect(requests[3].tools).toContain("mcp__docs__search");
		expect(requests[3].toolsHash).toBe(requests[2].toolsHash);
	}, 120_000);

	for (const target of TARGETS) {
		it(`${target.id}/${target.model}: turn 2 and the post-change request, measured live`, async (ctx) => {
			if (!LIVE) return ctx.skip("live provider probe: set TESTKIT_LIVE=1 (costs money)");
			requireBundle(ctx);
			const provider = loadProvider(target.id, target.model);
			if (typeof provider === "string") return ctx.skip(provider);
			const { requests, run } = await probe(provider, BUNDLE);
			const p = target.price;
			const cost = requests.reduce(
				(s, r) =>
					s +
					(r.usage.uncached * p.input +
						r.usage.cacheRead * p.read +
						r.usage.cacheWrite * p.write +
						r.usage.output * p.output) /
						1e6,
				0,
			);
			const result = {
				provider: target.id,
				model: target.model,
				api: provider.api,
				exitCode: run.exitCode,
				timedOut: run.timedOut,
				estimatedUsd: Number(cost.toFixed(4)),
				anthropicBeta: requests.map((r) => r.anthropicBeta ?? ""),
				requests: requests.map(row),
				rawUsage: requests.map((r) => r.rawUsage),
				recordedUsage: recordedUsage(run.events),
				stderrTail: run.stderr.slice(-1500),
			};
			const dir = process.env.TESTKIT_REPORT_DIR ?? join(process.cwd(), ".octocode", "agent", "tmp");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `testkit-live-cache-${target.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
			console.info(`[live-cache:${target.id}] ${JSON.stringify(result)}`);
			// Reports, not verdicts: the probe passes when the session ran and the provider answered every request.
			expect(requests.length, run.stderr.slice(-1500)).toBeGreaterThanOrEqual(3);
			expect(requests.every((r) => r.status === 200)).toBe(true);
		}, 300_000);
	}

	// B598: the long retention tiers through the user's own gateways. The temp models.json declares
	// `compat.supportsLongCacheRetention`, `OCTOCODE_CACHE_RETENTION=long` asks for it, and the write TTL is read from usage.
	const LONG = [
		{ ...TARGETS[0], tier: "1h", extra: {} },
		{ ...TARGETS[1], tier: "12h", extra: { supportsExplicitPromptCacheMode: true } },
	] as const;
	for (const target of LONG) {
		it(`${target.id}/${target.model}: long retention (${target.tier}) through the gateway, write TTL in usage`, async (ctx) => {
			if (!LIVE) return ctx.skip("live provider probe: set TESTKIT_LIVE=1 (costs money)");
			requireBundle(ctx);
			const base = loadProvider(target.id, target.model);
			if (typeof base === "string") return ctx.skip(base);
			const compat = {
				...(base.model.compat as Record<string, unknown> | undefined),
				supportsLongCacheRetention: true,
				...target.extra,
			};
			const provider: ProbeProvider = { ...base, model: { ...base.model, compat } };
			const { requests, run } = await probe(provider, BUNDLE, {
				prompts: PROMPTS.slice(0, 2),
				env: { OCTOCODE_CACHE_RETENTION: "long" },
				withMcp: false,
			});
			const p = target.price;
			const cost = requests.reduce(
				(s, r) =>
					s +
					(r.usage.uncached * p.input +
						r.usage.cacheRead * p.read +
						r.usage.cacheWrite * p.write +
						r.usage.output * p.output) /
						1e6,
				0,
			);
			const result = {
				provider: target.id,
				model: target.model,
				tier: target.tier,
				exitCode: run.exitCode,
				estimatedUsd: Number(cost.toFixed(4)),
				requests: requests.map(row),
				rawUsage: requests.map((r) => r.rawUsage),
				stderrTail: run.stderr.slice(-1500),
			};
			const dir = process.env.TESTKIT_REPORT_DIR ?? join(process.cwd(), ".octocode", "agent", "tmp");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `testkit-live-retention-${target.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
			console.info(`[live-retention:${target.id}] ${JSON.stringify(result)}`);
			expect(requests.length, run.stderr.slice(-1500)).toBeGreaterThanOrEqual(2);
			expect(requests.every((r) => r.status === 200)).toBe(true);
			// The request asked for the long tier ...
			const asked = JSON.stringify(requests[0].cacheMarkers);
			expect(asked, `request markers ${asked}`).toContain(target.tier === "1h" ? "cache_control:1h" : "12h");
			// ... and the provider billed the write at that tier: all of request 1's write tokens carry the long TTL.
			const first = requests[0];
			if (target.tier === "1h") expect(first.usage.write1h).toBe(first.usage.cacheWrite);
			else {
				const details = (first.rawUsage.input_tokens_details as { cache_write_tokens_details?: Record<string, number> })
					.cache_write_tokens_details;
				expect(details?.ttl_12h_tokens, JSON.stringify(details)).toBe(first.usage.cacheWrite);
				expect(details?.ttl_30m_tokens).toBe(0);
			}
		}, 300_000);
	}
});
