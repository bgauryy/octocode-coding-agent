import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheEvents, formatSummary, resetCacheEvents, summarize } from "../src/cache-report.ts";
import type { CassetteMode, Fingerprint } from "../src/cassette.ts";
import { runInproc } from "../src/agents/inproc.ts";
import { startGateway } from "../src/gateway.ts";
import { chat, gateway, mcp, searchTool } from "./helpers.ts";

const closers: (() => void)[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const c of closers.splice(0)) c();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => resetCacheEvents());

const cassetteFile = (): string => {
	const d = mkdtempSync(join(tmpdir(), "testkit-cache-"));
	dirs.push(d);
	return join(d, "run.json");
};

interface Upstream {
	base: string;
	calls: number;
	/** Fixed replies (by call number) instead of the tool-loop script. */
	answers?: string[];
}

/** Anthropic-wire upstream that counts calls: two tool calls, then an answer (or fixed `answers`). */
async function upstream(latencyMs = 0): Promise<Upstream> {
	const up: Upstream = { base: "", calls: 0 };
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString()) as {
				messages: { content: { type: string }[] }[];
			};
			const n = up.calls++;
			const results = body.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result").length;
			const content = up.answers
				? [{ type: "text", text: up.answers[n] ?? "extra" }]
				: results < 2
					? [{ type: "tool_use", id: `toolu_01abcdef${n}`, name: "search", input: { query: `q${results}` } }]
					: [{ type: "text", text: "found it" }];
			setTimeout(() => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						content,
						usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 },
					}),
				);
			}, latencyMs);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	up.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	closers.push(() => {
		server.closeAllConnections();
		server.close();
	});
	return up;
}

const gw = (up: Upstream, file: string, mode?: CassetteMode, fingerprint?: Fingerprint) =>
	gateway({
		forward: { baseUrl: up.base, model: "m1", api: "anthropic", key: "sk-test-not-real" },
		cassette: { file, mode, fingerprint },
	});

async function agent(g: Awaited<ReturnType<typeof gw>>, prompt = "find it") {
	const docs = mcp(g, "docs", [searchTool]);
	return runInproc({ gatewayUrl: g.url, trace: g.trace, mcp: [docs.client()], model: "m1" }, prompt);
}

describe("run cache: hit, miss, stale", () => {
	it("auto records on a miss, then answers every request from the cassette with zero upstream calls", async () => {
		const up = await upstream();
		const f = cassetteFile();
		const first = await agent(await gw(up, f));
		expect(first.answer).toBe("found it");
		expect(up.calls).toBe(3);
		expect(summarize(cacheEvents())).toMatchObject({ hits: 0, misses: 3, recorded: 3, upstreamCalls: 3 });

		resetCacheEvents();
		const before = up.calls;
		const second = await agent(await gw(up, f));
		expect(second.answer).toBe("found it");
		expect(up.calls).toBe(before);
		expect(summarize(cacheEvents())).toMatchObject({ hits: 3, misses: 0, recorded: 0, upstreamCallsAvoided: 3 });
	});

	it("must fail: with the cassette off every run reaches upstream, and a changed prompt misses", async () => {
		const up = await upstream();
		const f = cassetteFile();
		await agent(await gw(up, f));
		const recorded = up.calls;
		await agent(await gw(up, f, "off"));
		expect(up.calls).toBe(recorded + 3);
		await agent(await gw(up, f), "a different question");
		expect(up.calls).toBe(recorded + 3 + 3);
	});

	it("scripted runs create no cassette in auto mode", async () => {
		const g = await gateway();
		expect((await chat(g.url, { model: "m", messages: [{ role: "user", content: "hi" }] })).status).toBe(200);
		expect(cacheEvents()).toEqual([]);
	});

	it("a changed fingerprint is stale: auto re-records and reports it, replay fails naming the field", async () => {
		const up = await upstream();
		const f = cassetteFile();
		await agent(await gw(up, f, "auto", { bundle: "aaaa" }));
		const recorded = up.calls;

		resetCacheEvents();
		await agent(await gw(up, f, "auto", { bundle: "bbbb" }));
		expect(up.calls).toBe(recorded + 3);
		expect(summarize(cacheEvents())).toMatchObject({ stale: 3, hits: 0, recorded: 3 });
		expect(
			(JSON.parse(readFileSync(f, "utf8")) as { header: { fingerprint: Fingerprint } }).header.fingerprint,
		).toMatchObject({
			bundle: "bbbb",
		});

		resetCacheEvents();
		await agent(await gw(up, f, "auto", { bundle: "bbbb" }));
		expect(up.calls).toBe(recorded + 3);
		expect(summarize(cacheEvents())).toMatchObject({ stale: 0, hits: 3 });

		await expect(
			startGateway({
				forward: { baseUrl: up.base, model: "m1", api: "anthropic" },
				cassette: { file: f, mode: "replay", fingerprint: { bundle: "cccc" } },
			}),
		).rejects.toThrow(/cassette stale: .*bundle: "bbbb" -> "cccc"/);
	});

	it("must fail: an unchanged fingerprint is never stale, and a model change is", async () => {
		const up = await upstream();
		const f = cassetteFile();
		await agent(await gw(up, f, "auto", { adapter: { name: "x", version: "1" } }));
		const g = await gw(up, f, "replay", { adapter: { name: "x", version: "1" } });
		expect(g.errors).toEqual([]);
		await expect(
			startGateway({
				forward: { baseUrl: up.base, model: "other", api: "anthropic" },
				cassette: { file: f, mode: "replay", fingerprint: { adapter: { name: "x", version: "1" } } },
			}),
		).rejects.toThrow(/stale.*model: "m1" -> "other"/);
	});
});

describe("occurrence index", () => {
	const ask = (url: string) => chat(url, { model: "m1", messages: [{ role: "user", content: "same question" }] });
	const text = async (r: Response) =>
		((await r.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content;

	it("keeps repeated identical requests distinct", async () => {
		const up = await upstream();
		up.answers = ["first", "second", "third"];
		const f = cassetteFile();
		const rec = await gw(up, f);
		expect([await text(await ask(rec.url)), await text(await ask(rec.url)), await text(await ask(rec.url))]).toEqual([
			"first",
			"second",
			"third",
		]);
		const keys = Object.keys((JSON.parse(readFileSync(f, "utf8")) as { entries: object }).entries);
		expect(keys.map((k) => k.split("#")[0]).every((h) => h === keys[0].split("#")[0])).toBe(true);
		expect(keys.map((k) => k.split("#")[1])).toEqual(["0", "1", "2"]);

		const calls = up.calls;
		const rep = await gw(up, f, "replay");
		expect([await text(await ask(rep.url)), await text(await ask(rep.url)), await text(await ask(rep.url))]).toEqual([
			"first",
			"second",
			"third",
		]);
		expect(up.calls).toBe(calls);
	});

	it("must fail: a fourth identical request has no recording", async () => {
		const up = await upstream();
		const f = cassetteFile();
		const rec = await gw(up, f);
		await ask(rec.url);
		await ask(rec.url);
		const rep = await gw(up, f, "replay");
		expect((await ask(rep.url)).status).toBe(200);
		expect((await ask(rep.url)).status).toBe(200);
		const third = await ask(rep.url);
		expect(third.status).toBe(502);
		expect(JSON.stringify(await third.json())).toMatch(/cassette miss: no recorded reply for [0-9a-f]{16}#2/);
	});
});

describe("replay is identical", () => {
	const shape = (g: Awaited<ReturnType<typeof gw>>) => ({
		hashes: g.trace.requests.map((r) => r.hash),
		usage: g.trace.requests.map((r) => r.usage),
		events: g.trace.events.map((e) => [e.kind, e.agent, e.name, e.args, e.data]),
	});

	it("a replayed inproc run has the same trace hashes, usage and events with the upstream gone", async () => {
		const up = await upstream();
		const f = cassetteFile();
		const rec = await gw(up, f, "record");
		await agent(rec);
		const calls = up.calls;
		const rep = await gw(up, f, "replay");
		await agent(rep);
		expect(up.calls).toBe(calls);
		expect(shape(rep)).toEqual(shape(rec));
		expect(rep.trace.requests[0].usage).toMatchObject({ promptTokens: 140, cachedTokens: 40, estimated: false });
	});

	it("must fail: a different prompt does not replay", async () => {
		const up = await upstream();
		const f = cassetteFile();
		await agent(await gw(up, f, "record"));
		const rep = await gw(up, f, "replay");
		await expect(agent(rep, "another prompt")).rejects.toThrow(/cassette miss/);
		expect(rep.errors[0]).toMatch(/cassette miss/);
	});
});

describe("cache report", () => {
	it("counts time saved from the recorded latency, and nothing on a cold run", async () => {
		const up = await upstream(40);
		const f = cassetteFile();
		await agent(await gw(up, f));
		const cold = summarize(cacheEvents());
		expect(cold).toMatchObject({ hits: 0, timeSavedMs: 0, upstreamCallsAvoided: 0 });
		resetCacheEvents();
		await agent(await gw(up, f));
		const warm = summarize(cacheEvents());
		expect(warm.hits).toBe(3);
		expect(warm.timeSavedMs).toBeGreaterThanOrEqual(3 * 35);
		expect(warm.inputTokensAvoided).toBe(3 * 140);
		expect(formatSummary(warm)).toMatch(/3\/3 hits.*\n.*avoided 3, made 0/);
	});

	it("separates the provider prompt cache from the run cache", () => {
		const usage = { promptTokens: 140, cachedTokens: 40, completionTokens: 5, estimated: false };
		const s = summarize([
			{ file: "a", outcome: "miss" },
			{ file: "a", outcome: "recorded", upstreamMs: 10, usage },
			{ file: "a", outcome: "recorded", upstreamMs: 10, usage: { ...usage, estimated: true } },
		]);
		expect(s.providerCache).toEqual({ promptTokens: 140, cachedTokens: 40 });
		expect(s.hits).toBe(0);
	});
});
