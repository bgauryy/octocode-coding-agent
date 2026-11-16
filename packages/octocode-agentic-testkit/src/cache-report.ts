import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "./trace.ts";

/** Where cassettes and the cache report live: `TESTKIT_REPORT_DIR` (the vitest config sets it), else the OS temp dir. */
export function cacheDir(): string {
	return process.env.TESTKIT_REPORT_DIR ?? join(tmpdir(), "testkit");
}

export interface CacheEvent {
	file: string;
	/** `hit` replayed; `miss` no entry; `stale` entry from another fingerprint; `recorded` upstream reply saved. */
	outcome: "hit" | "miss" | "stale" | "recorded";
	/** hit: latency of the upstream call that produced the entry. */
	recordedMs?: number;
	/** hit: time the replay lookup took. */
	replayMs?: number;
	/** recorded: latency of the upstream call. */
	upstreamMs?: number;
	usage?: Usage;
}

export interface CacheSummary {
	hits: number;
	misses: number;
	stale: number;
	recorded: number;
	/** Requests that would have gone upstream without the run cache. */
	upstreamCallsAvoided: number;
	/** Requests that did go upstream through a cassette. */
	upstreamCalls: number;
	/** Sum over hits of recorded upstream latency minus replay time. */
	timeSavedMs: number;
	/** Real (provider-reported) input tokens the hits did not send upstream. */
	inputTokensAvoided: number;
	/** Provider prompt cache on the calls that did go upstream (real usage only). */
	providerCache: { promptTokens: number; cachedTokens: number };
}

let local: CacheEvent[] = [];

export function summarize(events: CacheEvent[]): CacheSummary {
	const s: CacheSummary = {
		hits: 0,
		misses: 0,
		stale: 0,
		recorded: 0,
		upstreamCallsAvoided: 0,
		upstreamCalls: 0,
		timeSavedMs: 0,
		inputTokensAvoided: 0,
		providerCache: { promptTokens: 0, cachedTokens: 0 },
	};
	for (const e of events) {
		if (e.outcome === "hit") {
			s.hits++;
			s.upstreamCallsAvoided++;
			s.timeSavedMs += Math.max(0, (e.recordedMs ?? 0) - (e.replayMs ?? 0));
			if (e.usage && !e.usage.estimated) s.inputTokensAvoided += e.usage.promptTokens;
		} else if (e.outcome === "miss") s.misses++;
		else if (e.outcome === "stale") s.stale++;
		else {
			s.recorded++;
			s.upstreamCalls++;
			if (e.usage && !e.usage.estimated) {
				s.providerCache.promptTokens += e.usage.promptTokens;
				s.providerCache.cachedTokens += e.usage.cachedTokens;
			}
		}
	}
	s.timeSavedMs = Math.round(s.timeSavedMs);
	return s;
}

/** Count one cassette event in this process and, under `vitest run`, in the shared run directory. */
export function recordCacheEvent(e: CacheEvent): void {
	local.push(e);
	const dir = process.env.TESTKIT_CACHE_RUN_DIR;
	if (dir && existsSync(dir)) appendFileSync(join(dir, `${process.pid}.jsonl`), `${JSON.stringify(e)}\n`);
}

/** Events counted in this process since the last reset. */
export function cacheEvents(): CacheEvent[] {
	return [...local];
}

export function resetCacheEvents(): void {
	local = [];
}

export function formatSummary(s: CacheSummary): string {
	const total = s.hits + s.misses + s.stale;
	return [
		`testkit run cache: ${s.hits}/${total} hits, ${s.misses} misses, ${s.stale} stale, ${s.recorded} recorded`,
		`  upstream calls avoided ${s.upstreamCallsAvoided}, made ${s.upstreamCalls}; time saved ${s.timeSavedMs} ms; input tokens not re-sent ${s.inputTokensAvoided}`,
		`  provider prompt cache on live calls: ${s.providerCache.cachedTokens}/${s.providerCache.promptTokens} input tokens read from cache`,
	].join("\n");
}

/** vitest `globalSetup`: one run directory for all workers; the teardown writes the report and prints it once. */
export default function setup(): () => void {
	const dir = join(cacheDir(), `testkit-cache-run-${process.pid}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	process.env.TESTKIT_CACHE_RUN_DIR = dir;
	return () => {
		const events = readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.flatMap((f) =>
				readFileSync(join(dir, f), "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l) as CacheEvent),
			);
		rmSync(dir, { recursive: true, force: true });
		const summary = summarize(events);
		const byFile: Record<string, CacheSummary> = {};
		for (const file of new Set(events.map((e) => e.file)))
			byFile[file] = summarize(events.filter((e) => e.file === file));
		mkdirSync(cacheDir(), { recursive: true });
		writeFileSync(
			join(cacheDir(), "testkit-cache-report.json"),
			JSON.stringify({ generatedAt: new Date().toISOString(), ...summary, cassettes: byFile }, null, "\t"),
		);
		if (events.length) console.log(formatSummary(summary));
	};
}
