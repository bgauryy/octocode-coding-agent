import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cacheDir, recordCacheEvent } from "./cache-report.ts";
import type { Reply } from "./reply.ts";

/**
 * `auto` replays a hit and records a miss (only when a real upstream is configured: scripted runs need no cassette),
 * `record` always calls upstream and rewrites the file, `replay` answers from the file and fails on a miss,
 * `off` disables the cassette. `TESTKIT_CASSETTE` sets the default; an explicit option wins.
 */
export type CassetteMode = "auto" | "record" | "replay" | "off";

/** What a recording depends on; any difference makes the recording stale. */
export interface Fingerprint {
	adapter?: { name: string; version?: string };
	/** Hash of the harness bundle under test (see `fileHash`). */
	bundle?: string;
	tier?: string;
	model?: string;
}

export interface CassetteOptions {
	/** Default: `<cache dir>/testkit-cassettes/<tier>-<model>-<upstream hash>.json`. */
	file?: string;
	/** Default: `TESTKIT_CASSETTE`, else `auto`. */
	mode?: CassetteMode;
	/** Merged over the gateway's own (`model`, `tier`). */
	fingerprint?: Fingerprint;
	/**
	 * Statistical trials: the trial index. Each sample records and replays its own reply, so trial 2 never
	 * replays trial 1. Without it, a repeated run through a new gateway replays the first recording.
	 */
	sample?: string | number;
}

interface Entry {
	reply: Reply;
	/** Wall time of the upstream call that produced the reply. */
	latencyMs: number;
}

interface CassetteFile {
	header: { version: 1; fingerprint: Fingerprint; recordedAt: string };
	entries: Record<string, Entry>;
}

/** What the gateway does for one request. */
export type Plan = { action: "replay"; reply: Reply } | { action: "call" };

const MODES: CassetteMode[] = ["auto", "record", "replay", "off"];

function cassetteModeFromEnv(env: Record<string, string | undefined> = process.env): CassetteMode {
	const v = (env.TESTKIT_CASSETTE ?? "auto").toLowerCase();
	if (!MODES.includes(v as CassetteMode)) throw new Error(`TESTKIT_CASSETTE=${v} is not one of ${MODES.join(", ")}`);
	return v as CassetteMode;
}

/** Short hash of a file's bytes, for `Fingerprint.bundle`. */
export function fileHash(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
}

const stable = (f: Fingerprint): string =>
	JSON.stringify(f, (_k, v: unknown) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(
					Object.entries(v)
						.filter(([, x]) => x !== undefined)
						.sort(([a], [b]) => (a < b ? -1 : 1)),
				)
			: v,
	);

function diff(recorded: Fingerprint, current: Fingerprint): string {
	const a = JSON.parse(stable(recorded)) as Record<string, unknown>;
	const b = JSON.parse(stable(current)) as Record<string, unknown>;
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
		(k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]),
	);
	return keys.map((k) => `${k}: ${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])}`).join("; ");
}

const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "upstream";

const STALE_FILE_DAYS = 14;

/** Default cassette file: one per tier, model and upstream, so unrelated upstreams never share replies. Prunes old ones. */
function defaultCassetteFile(fp: Fingerprint, upstream: string): string {
	const dir = join(cacheDir(), "testkit-cassettes");
	if (existsSync(dir))
		for (const f of readdirSync(dir)) {
			const p = join(dir, f);
			if (Date.now() - statSync(p).mtimeMs > STALE_FILE_DAYS * 86_400_000) rmSync(p, { force: true });
		}
	const where = createHash("sha256").update(upstream).digest("hex").slice(0, 8);
	return join(dir, `${slug(fp.tier ?? "upstream")}-${slug(fp.model ?? "any")}-${where}.json`);
}

/**
 * Replies keyed by `<masked canonical hash>#<occurrence>`: the hash covers model, messages and tools with ids,
 * dates, sandbox paths and secrets masked; the occurrence index tells repeated identical requests apart.
 * The file header holds the fingerprint the replies were recorded under.
 */
export class Cassette {
	readonly mode: Exclude<CassetteMode, "off">;
	readonly file: string;
	private readonly fingerprint: Fingerprint;
	private entries: Record<string, Entry> = {};
	/** Entries recorded under another fingerprint: a request that hits one is stale, not a miss. */
	private staleKeys = new Set<string>();
	private readonly fresh: Record<string, Entry> = {};
	private readonly seen = new Map<string, number>();
	private readonly sample: string;
	/** The first write replaces the file instead of merging with it (record mode, stale file). */
	private replaceOnWrite: boolean;
	private written = false;

	/**
	 * `undefined` when the cassette is off: mode `off`, or `auto` without a real upstream.
	 * @param upstream base URL of the real upstream, when one is configured
	 */
	static open(
		opts: CassetteOptions | undefined,
		upstream: string | undefined,
		base: Fingerprint,
	): Cassette | undefined {
		const forwarding = upstream !== undefined;
		if (!opts && !forwarding) return undefined;
		const mode = opts?.mode ?? cassetteModeFromEnv();
		if (mode === "off" || (mode === "auto" && !forwarding)) return undefined;
		const fingerprint = { ...base, ...opts?.fingerprint };
		const file = opts?.file ?? defaultCassetteFile(fingerprint, upstream ?? "scripted");
		return new Cassette(mode, file, fingerprint, opts?.sample);
	}

	private constructor(
		mode: Exclude<CassetteMode, "off">,
		file: string,
		fingerprint: Fingerprint,
		sample: string | number | undefined,
	) {
		this.mode = mode;
		this.sample = sample === undefined ? "" : `@${sample}`;
		this.file = file;
		this.fingerprint = fingerprint;
		this.replaceOnWrite = mode === "record";
		if (mode === "record") return;
		if (!existsSync(file)) {
			if (mode === "replay") throw new Error(`cassette ${file} does not exist (record it first)`);
			return;
		}
		const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<CassetteFile>;
		const why = !saved.header
			? "it has no header (older format)"
			: stable(saved.header.fingerprint) === stable(fingerprint)
				? ""
				: diff(saved.header.fingerprint, fingerprint);
		if (!why) {
			this.entries = saved.entries ?? {};
			return;
		}
		if (mode === "replay")
			throw new Error(`cassette stale: ${file} was recorded under another fingerprint (${why}); re-record`);
		this.staleKeys = new Set(Object.keys(saved.entries ?? {}));
		this.replaceOnWrite = true;
	}

	/** Next key for a request with this hash. */
	key(hash: string): string {
		const n = this.seen.get(hash) ?? 0;
		this.seen.set(hash, n + 1);
		return `${hash}#${n}${this.sample}`;
	}

	/** Replay it, or tell the gateway to call upstream and `record` the reply. Replay mode throws on a miss. */
	plan(key: string): Plan {
		if (this.mode === "record") return { action: "call" };
		const t0 = performance.now();
		const entry = this.entries[key];
		if (entry) {
			recordCacheEvent({
				file: this.file,
				outcome: "hit",
				recordedMs: entry.latencyMs,
				replayMs: performance.now() - t0,
				usage: entry.reply.usage,
			});
			return { action: "replay", reply: entry.reply };
		}
		recordCacheEvent({ file: this.file, outcome: this.staleKeys.has(key) ? "stale" : "miss" });
		if (this.mode === "replay")
			throw new Error(
				`cassette miss: no recorded reply for ${key} in ${this.file} (${Object.keys(this.entries).length} entries); re-record`,
			);
		return { action: "call" };
	}

	record(key: string, reply: Reply, latencyMs: number): void {
		this.fresh[key] = { reply, latencyMs };
		recordCacheEvent({ file: this.file, outcome: "recorded", upstreamMs: latencyMs, usage: reply.usage });
		const merged = { ...(this.replaceOnWrite && !this.written ? {} : this.onDisk()), ...this.fresh };
		const out: CassetteFile = {
			header: { version: 1, fingerprint: this.fingerprint, recordedAt: new Date().toISOString() },
			entries: merged,
		};
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(out, null, "\t"));
		renameSync(tmp, this.file);
		this.written = true;
		this.entries = merged;
		this.staleKeys.delete(key);
	}

	/** Entries another gateway wrote since we loaded, if the file still matches our fingerprint. */
	private onDisk(): Record<string, Entry> {
		if (!existsSync(this.file)) return {};
		const saved = JSON.parse(readFileSync(this.file, "utf8")) as Partial<CassetteFile>;
		return saved.header && stable(saved.header.fingerprint) === stable(this.fingerprint) ? (saved.entries ?? {}) : {};
	}
}
