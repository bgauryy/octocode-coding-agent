import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderResult, saveResult, summarizeResults, Trace, type LiveSummary } from "../src/index.ts";
import type { AgentReport } from "../src/reporter.ts";
import { escapeHtml, renderResultsHtml } from "../src/results-html.ts";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/results.mjs");
let dir: string;
let saved: string | undefined;

beforeEach(() => {
	saved = process.env.TESTKIT_RESULTS_DIR;
	dir = mkdtempSync(join(tmpdir(), "testkit-results-"));
});
afterEach(() => {
	if (saved === undefined) delete process.env.TESTKIT_RESULTS_DIR;
	else process.env.TESTKIT_RESULTS_DIR = saved;
	rmSync(dir, { recursive: true, force: true });
});

const live: LiveSummary = {
	decision: "pass",
	trials: 3,
	successes: 3,
	failures: 0,
	passRate: 1,
	probability: 0.9,
	threshold: 0.7,
	stoppedEarly: false,
};

function traced(): Trace {
	const t = new Trace();
	t.record({ kind: "tool_exec", span: "s", agent: "main", name: "read", args: { path: "x".repeat(300) } });
	return t;
}

/** A fake test context: only the fields `saveResult` reads. */
function fake(name: string, state?: string) {
	return {
		task: {
			name,
			file: { filepath: join(process.cwd(), "test/a.test.ts") },
			result: state ? { state } : undefined,
			meta: {},
		},
	} as never as Parameters<typeof saveResult>[0];
}

describe("saved results", () => {
	it("writes nothing when the variable is unset", () => {
		delete process.env.TESTKIT_RESULTS_DIR;
		expect(saveResult(fake("t"), { note: "n" })).toBeUndefined();
		expect(readdirSync(dir)).toEqual([]);
	});

	it("writes trace and live fields and records the path", () => {
		process.env.TESTKIT_RESULTS_DIR = dir;
		const ctx = fake("does a thing");
		const path = saveResult(ctx, { trace: traced(), live, run: { stdout: "o".repeat(30000), stderr: "e" } });
		expect(path).toBe(join(dir, "test__a.test.ts", "does_a_thing.json"));
		const json = JSON.parse(readFileSync(path!, "utf8"));
		expect(json).toMatchObject({ test: "does a thing", file: "test/a.test.ts", state: "running", live });
		expect(json.trace.events).toHaveLength(1);
		expect(json.run.stdout).toHaveLength(20000);
		expect((ctx.task.meta as Record<string, unknown>).testkitResult).toBe(path);
	});

	it("lists failures first", () => {
		process.env.TESTKIT_RESULTS_DIR = dir;
		saveResult(fake("good", "pass"), { trace: traced() });
		saveResult(fake("bad", "fail"), { live: { ...live, decision: "fail" } });
		const rows = summarizeResults(dir);
		expect(rows.map((r) => r.test)).toEqual(["bad", "good"]);
		expect(rows[0]).toMatchObject({ state: "fail", failedChecks: ["live"], requests: 0 });
		expect(rows[1]).toMatchObject({ events: 1 });
	});

	it("renders the event table with truncated args", () => {
		process.env.TESTKIT_RESULTS_DIR = dir;
		const path = saveResult(fake("render"), { trace: traced(), live })!;
		const md = renderResult(JSON.parse(readFileSync(path, "utf8")));
		expect(md).toContain("| seq | agent | kind | name | args |");
		expect(md).toMatch(/\| 0 \| main \| tool_exec \| read \| .{1,125} \|/);
		expect(md).not.toContain("x".repeat(130));
		expect(md).toContain("| index | agent | model | bytes | usage |");
	});

	it("the script lists results and prints one on a substring", () => {
		process.env.TESTKIT_RESULTS_DIR = dir;
		saveResult(fake("scripted", "fail"), { trace: traced() });
		const list = spawnSync("node", [script, dir], { encoding: "utf8" });
		expect(list.status).toBe(0);
		expect(list.stdout).toContain("fail");
		expect(list.stdout).toContain("scripted");
		const one = spawnSync("node", [script, dir, "scripted"], { encoding: "utf8" });
		expect(one.stdout).toContain("# scripted");
		expect(one.stdout).toContain("| seq | agent |");
	});
});

const XSS = "<script>alert(1)</script>";

/** A trace whose model text, tool args and request carry markup. */
function hostile(): Trace {
	const t = new Trace();
	t.record({ kind: "model_tool_call", span: "s", agent: "main", name: "search", args: { q: XSS } });
	t.record({ kind: "model_tool_call", span: "s", agent: "main", name: "rm", data: { blocked: "guard" } });
	t.record({ kind: "answer", span: "s", agent: "main", data: `done ${XSS}` });
	t.requests.push({
		index: 0,
		agent: "main",
		span: "s",
		model: "m",
		stream: false,
		messages: [{ role: "user", content: `please ${XSS}` }],
		tools: [],
		raw: {},
		canonical: "",
		hash: "h",
		bytes: 10,
	});
	return t;
}

const report: AgentReport = {
	totals: { tests: 2, costUsd: 0.5, toolCoverage: 0.5, neverExecuted: ["docs.fetch"], skills: [], guards: 0 },
	tests: [
		{ test: "suite ok", state: "passed", passes: 3, runs: 3, needed: 3, interval: [0.4, 1] as [number, number] },
		{ test: "suite flaky", state: "failed", passes: 1, runs: 3, needed: 3, interval: [0.06, 0.79] as [number, number] },
	].map((t) => ({
		...t,
		adapter: "reference",
		costUsd: 0.25,
		requests: 4,
		failures: [],
		toolsAdvertised: [],
		toolsExecuted: [],
		modelTools: [],
		skills: [],
		guards: [],
		trajectories: [["search"]],
	})),
};

describe("HTML report", () => {
	it("escapes every markup character", () => {
		expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
		expect(escapeHtml({ k: "<b>" })).toBe("{&quot;k&quot;:&quot;&lt;b&gt;&quot;}");
	});

	it("escapes model text from the trace, so no script survives", () => {
		process.env.TESTKIT_RESULTS_DIR = dir;
		saveResult(fake(`named ${XSS}`, "fail"), { trace: hostile(), note: XSS });
		const html = renderResultsHtml(dir);
		expect(html).not.toMatch(/<script/i);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toMatch(/<link|src=|https?:\/\//i);
		expect(html).toContain("@media (prefers-color-scheme:dark)");
	});

	it("lists failures first, with status, live summary, judgement, request count and tool sequence", () => {
		process.env.TESTKIT_RESULTS_DIR = dir;
		saveResult(fake("good", "pass"), { trace: traced(), live });
		saveResult(fake("bad", "fail"), {
			trace: hostile(),
			judgement: {
				pass: false,
				criteria: [{ id: "cites", criterion: "cites a file", pass: false, reason: "no path" }],
				usage: { promptTokens: 1, completionTokens: 1 },
			},
		});
		const html = renderResultsHtml(dir);
		const section = (name: string): string => {
			const at = html.indexOf(`</span> ${name}</h3>`);
			expect(at).toBeGreaterThan(-1);
			return html.slice(at, html.indexOf("</section>", at));
		};
		expect(html.indexOf("</span> bad</h3>")).toBeLessThan(html.indexOf("</span> good</h3>"));
		expect(html.indexOf(">test/a.test.ts › bad<")).toBeLessThan(html.indexOf(">test/a.test.ts › good<"));
		const bad = section("bad");
		expect(bad).toContain("<dt>requests</dt><dd>1</dd>");
		expect(bad).toContain("<dt>tool calls</dt><dd>search → rm (blocked)</dd>");
		expect(bad).toMatch(/<dt>judgement<\/dt>.*FAIL.*cites.*no path/);
		expect(bad).toContain("<details><summary>Trace: 3 events, 1 requests</summary>");
		const good = section("good");
		expect(good).toContain("<dt>live</dt><dd>pass: 3/3 passed, P(rate&gt;0.7) = 0.900</dd>");
		expect(good).toContain("<dt>tool calls</dt><dd>none</dd>");
	});

	it("reads the agent report in the directory, failing tests first, and never lists it as a result", () => {
		process.env.TESTKIT_RESULTS_DIR = dir;
		saveResult(fake("only"), { note: "n" });
		writeFileSync(join(dir, "testkit-agent-report.json"), JSON.stringify(report));
		expect(summarizeResults(dir).map((r) => r.test)).toEqual(["only"]);
		const html = renderResultsHtml(dir);
		expect(html).toContain("<h2>Agent report</h2>");
		expect(html).toContain("50.0% of mock tools executed; never: docs.fetch");
		expect(html.indexOf("suite flaky")).toBeLessThan(html.indexOf("suite ok"));
	});

	it("the script writes the page with --html and rejects a bad output argument", () => {
		process.env.TESTKIT_RESULTS_DIR = dir;
		saveResult(fake("scripted", "fail"), { trace: hostile() });
		const out = join(dir, "report.html");
		const run = spawnSync("node", [script, "--html", dir, out], { encoding: "utf8" });
		expect(run.status).toBe(0);
		expect(run.stdout).toContain(`1 results, 1 failing: ${out}`);
		expect(readFileSync(out, "utf8")).toContain("</span> scripted</h3>");
		const fallback = spawnSync("node", [script, "--html", dir], { encoding: "utf8" });
		expect(fallback.stdout).toContain(join(dir, "index.html"));
		const bad = spawnSync("node", [script, "--html", dir, "out.txt"], { encoding: "utf8" });
		expect(bad.status).toBe(1);
		expect(bad.stderr).toContain("is neither an existing directory nor an .html output path");
	});
});
