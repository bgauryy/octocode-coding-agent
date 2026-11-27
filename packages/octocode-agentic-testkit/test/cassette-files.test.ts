import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Cassette, type CassetteMode } from "../src/cassette.ts";
import type { Reply } from "../src/reply.ts";

const CASSETTE_MODULE = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../src/cassette.ts")).href;
const UPSTREAM = "http://upstream.test";
const BASE = { model: "m1", tier: "anthropic" };
const usage = { promptTokens: 1, cachedTokens: 0, completionTokens: 1, estimated: true };
const reply = (text: string): Reply => ({ text, toolCalls: [], usage });

const dirs: string[] = [];
const env: Record<string, string | undefined> = {};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
		delete env[k];
	}
});
const tempDir = (): string => {
	const d = mkdtempSync(join(tmpdir(), "testkit-cassette-files-"));
	dirs.push(d);
	return d;
};
const setEnv = (k: string, v: string): void => {
	if (!(k in env)) env[k] = process.env[k];
	process.env[k] = v;
};
const entries = (file: string): Record<string, { reply: Reply; run?: string }> =>
	(JSON.parse(readFileSync(file, "utf8")) as { entries: Record<string, { reply: Reply; run?: string }> }).entries;
const open = (opts: Parameters<typeof Cassette.open>[0]): Cassette => Cassette.open(opts, UPSTREAM, BASE)!;
/** Records one reply under `hash` and returns the key it went to. */
const recordOne = (c: Cassette, hash: string, text = hash): string => {
	const key = c.key(hash);
	if (c.mode !== "record") expect(c.plan(key)).toEqual({ action: "call" });
	c.record(key, reply(text), 1);
	return key;
};
const DAY = 86_400_000;
const thrown = (fn: () => unknown): string => {
	try {
		fn();
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
	throw new Error("expected a throw");
};
const age = (path: string, days: number): void => {
	const t = new Date(Date.now() - days * DAY);
	utimesSync(path, t, t);
};

describe("cassette directory", () => {
	it("cassette.dir holds the auto-named file, and a fresh cassette replays from it", () => {
		const dir = tempDir();
		const c = open({ dir, mode: "auto" });
		expect(dirname(c.file)).toBe(dir);
		const key = recordOne(c, "h1", "from dir");
		const replay = open({ dir, mode: "replay" });
		expect(replay.file).toBe(c.file);
		expect(replay.plan(replay.key("h1"))).toMatchObject({ action: "replay", reply: { text: "from dir" } });
		expect(key).toBe("h1#0");
	});

	it("TESTKIT_CASSETTE_DIR sets the directory, relative to the working directory; cassette.dir wins over it", () => {
		const dir = tempDir();
		setEnv("TESTKIT_CASSETTE_DIR", join(dir, "from-env"));
		expect(dirname(open({ mode: "auto" }).file)).toBe(join(dir, "from-env"));
		expect(dirname(open({ mode: "auto", dir: join(dir, "chosen") }).file)).toBe(join(dir, "chosen"));
		setEnv("TESTKIT_CASSETTE_DIR", "relative-cassettes");
		expect(dirname(open({ mode: "auto" }).file)).toBe(resolve("relative-cassettes"));
	});

	it("prunes old files and abandoned locks only in the default directory", () => {
		const reportDir = tempDir();
		setEnv("TESTKIT_REPORT_DIR", reportDir);
		const defaultDir = join(reportDir, "testkit-cassettes");
		mkdirSync(join(defaultDir, "old.json.lock"), { recursive: true });
		writeFileSync(join(defaultDir, "old.json"), "{}");
		writeFileSync(join(defaultDir, "recent.json"), "{}");
		age(join(defaultDir, "old.json"), 20);
		age(join(defaultDir, "old.json.lock"), 20);
		const chosen = tempDir();
		writeFileSync(join(chosen, "old.json"), "{}");
		age(join(chosen, "old.json"), 20);

		open({ mode: "auto", dir: chosen });
		open({ mode: "auto", file: join(chosen, "explicit.json") });
		setEnv("TESTKIT_CASSETTE_DIR", chosen);
		open({ mode: "auto" });
		expect(existsSync(join(chosen, "old.json"))).toBe(true);
		expect(existsSync(join(defaultDir, "old.json"))).toBe(true);

		delete process.env.TESTKIT_CASSETTE_DIR;
		expect(dirname(open({ mode: "auto" }).file)).toBe(defaultDir);
		expect(existsSync(join(defaultDir, "old.json"))).toBe(false);
		expect(existsSync(join(defaultDir, "old.json.lock"))).toBe(false);
		expect(existsSync(join(defaultDir, "recent.json"))).toBe(true);
	});

	it("must fail: replay without a file names the path it looked for and how to record it", () => {
		const reportDir = tempDir();
		setEnv("TESTKIT_REPORT_DIR", reportDir);
		const inDefault = thrown(() => open({ mode: "replay" }));
		expect(inDefault).toContain(`cassette ${join(reportDir, "testkit-cassettes", "anthropic-m1-")}`);
		expect(inDefault).toMatch(/TESTKIT_CASSETTE=auto/);
		// Only the untracked default needs the hint to choose a committed directory.
		expect(inDefault).toMatch(/TESTKIT_CASSETTE_DIR/);
		const dir = tempDir();
		const inChosen = thrown(() => open({ mode: "replay", dir }));
		expect(inChosen).toContain(`cassette ${join(dir, "anthropic-m1-")}`);
		expect(inChosen).not.toMatch(/TESTKIT_CASSETTE_DIR/);
		expect(thrown(() => open({ mode: "replay", file: join(dir, "x.json") }))).toContain(join(dir, "x.json"));
	});
});

describe("cassette entries", () => {
	it("stores the reply whole, so a field the gateway adds survives record and replay", () => {
		const file = join(tempDir(), "whole.json");
		const c = open({ file, mode: "auto" });
		const key = c.key("h");
		c.record(key, { ...reply("x"), extra: { kept: true } } as Reply, 1);
		const replay = open({ file, mode: "replay" });
		expect(replay.plan(replay.key("h"))).toMatchObject({ action: "replay", reply: { extra: { kept: true } } });
	});

	it("record mode drops earlier runs' entries but keeps every cassette of this run", () => {
		const file = join(tempDir(), "trials.json");
		const earlier = { reply: reply("old"), latencyMs: 1, run: "an-earlier-run" };
		writeFileSync(
			file,
			JSON.stringify({ header: { version: 1, fingerprint: BASE, recordedAt: "" }, entries: { "old#0": earlier } }),
		);
		recordOne(open({ file, mode: "record", sample: 0 }), "h");
		recordOne(open({ file, mode: "record", sample: 1 }), "h");
		expect(Object.keys(entries(file)).sort()).toEqual(["h#0@0", "h#0@1"]);
	});

	it("auto mode keeps earlier runs' entries", () => {
		const file = join(tempDir(), "auto.json");
		recordOne(open({ file, mode: "auto" }), "a");
		const saved = JSON.parse(readFileSync(file, "utf8")) as { entries: Record<string, { run?: string }> };
		saved.entries["a#0"].run = "an-earlier-run";
		writeFileSync(file, JSON.stringify(saved));
		recordOne(open({ file, mode: "auto" }), "b");
		expect(Object.keys(entries(file)).sort()).toEqual(["a#0", "b#0"]);
	});
});

/** Records `count` replies under hashes `<prefix>-<i>` in a child process, starting when `go` exists. */
function writer(file: string, prefix: string, count: number, go: string, mode: CassetteMode, run: string) {
	const code = `
		import { existsSync } from "node:fs";
		const { Cassette } = await import(${JSON.stringify(CASSETTE_MODULE)});
		const [file, prefix, count, go, mode] = process.argv.slice(1);
		process.stdout.write("ready\\n");
		while (!existsSync(go)) await new Promise((r) => setTimeout(r, 1));
		const c = Cassette.open({ file, mode }, ${JSON.stringify(UPSTREAM)}, ${JSON.stringify(BASE)});
		const usage = { promptTokens: 1, cachedTokens: 0, completionTokens: 1, estimated: true };
		for (let i = 0; i < Number(count); i++) {
			const key = c.key(prefix + "-" + i);
			if (mode !== "record" && c.plan(key).action !== "call") throw new Error("unexpected hit " + key);
			c.record(key, { text: key, toolCalls: [], usage }, 1);
		}
	`;
	const { TESTKIT_CACHE_RUN_DIR: _runDir, ...rest } = process.env;
	const child = spawn(process.execPath, ["--input-type=module", "-e", code, file, prefix, String(count), go, mode], {
		env: { ...rest, TESTKIT_RUN_ID: run },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
	const ready = new Promise<void>((ok) => child.stdout.once("data", () => ok()));
	const done = new Promise<void>((ok, fail) =>
		child.on("exit", (status) =>
			status === 0 ? ok() : fail(new Error(`writer ${prefix} exited ${status}: ${stderr}`)),
		),
	);
	return { ready, done };
}

describe("cassette writes across processes", () => {
	const WRITERS = 4;
	const EACH = 40;

	async function race(file: string, mode: CassetteMode): Promise<string[]> {
		const go = join(dirname(file), "go");
		const children = Array.from({ length: WRITERS }, (_, w) => writer(file, `w${w}`, EACH, go, mode, "one-run"));
		await Promise.all(children.map((c) => c.ready));
		writeFileSync(go, "");
		await Promise.all(children.map((c) => c.done));
		return Object.keys(entries(file)).sort();
	}
	const expected = Array.from({ length: WRITERS }, (_, w) => Array.from({ length: EACH }, (_, i) => `w${w}-${i}#0`))
		.flat()
		.sort();

	it("concurrent workers recording into one file in auto mode keep every entry", async () => {
		const file = join(tempDir(), "shared.json");
		expect(await race(file, "auto")).toEqual(expected);
		expect(existsSync(`${file}.lock`)).toBe(false);
	}, 60_000);

	it("concurrent workers of one run in record mode keep each other's entries and drop the old recording", async () => {
		const file = join(tempDir(), "shared.json");
		writeFileSync(
			file,
			JSON.stringify({
				header: { version: 1, fingerprint: BASE, recordedAt: "" },
				entries: { "old#0": { reply: reply("old"), latencyMs: 1, run: "an-earlier-run" } },
			}),
		);
		expect(await race(file, "record")).toEqual(expected);
	}, 60_000);
});
