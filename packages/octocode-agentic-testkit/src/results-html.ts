import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentReport } from "./reporter.ts";
import { AGENT_REPORT_FILE, loadResults, type SavedResult } from "./results.ts";

/** Raw trace JSON shown per test; the rest stays in the saved file. */
const RAW_MAX = 200_000;
const CELL_MAX = 300;

type Json = Record<string, any>;

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text for HTML: strings as is, everything else as JSON, with every markup character escaped. */
export function escapeHtml(v: unknown): string {
	const s = v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
	return s.replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

const cut = (v: unknown, max = CELL_MAX): string => {
	const s = v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
	return escapeHtml(s.length > max ? `${s.slice(0, max)}…` : s);
};

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

type Status = "fail" | "checks" | "pass" | "other";

function statusOf(r: SavedResult): Status {
	if (r.summary.state === "fail") return "fail";
	if (r.summary.failedChecks) return "checks";
	return r.summary.state === "pass" ? "pass" : "other";
}

const badge = (status: Status, label: string): string => `<span class="badge ${status}">${escapeHtml(label)}</span>`;

/** Tool names the model asked for, in call order; blocked calls are marked. */
function toolSequence(j: Json): string {
	const calls: Json[] = (j.trace?.events ?? []).filter((e: Json) => e.kind === "model_tool_call");
	if (!calls.length) return "none";
	return calls
		.map((e) => `${escapeHtml(e.name)}${e.data?.blocked ? " (blocked)" : e.data?.dropped ? " (dropped)" : ""}`)
		.join(" → ");
}

function liveBlock(live: Json | undefined): string {
	if (!live) return "";
	const errors = live.errors ? `, ${escapeHtml(live.errors)} errors` : "";
	const p = typeof live.probability === "number" ? live.probability.toFixed(3) : "?";
	return `<dt>live</dt><dd>${escapeHtml(live.decision)}: ${escapeHtml(live.successes)}/${escapeHtml(live.trials)} passed${errors}, P(rate&gt;${escapeHtml(live.threshold)}) = ${escapeHtml(p)}${live.lastError ? `; last error: ${cut(live.lastError)}` : ""}</dd>`;
}

function compareBlock(c: Json | undefined): string {
	if (!c) return "";
	const [lo, hi] = (c.interval ?? [Number.NaN, Number.NaN]) as number[];
	return `<dt>compare</dt><dd>${escapeHtml(c.verdict)}: base ${escapeHtml(c.base?.successes)}/${escapeHtml(c.base?.trials)}, treatment ${escapeHtml(c.treatment?.successes)}/${escapeHtml(c.treatment?.trials)}, Δ ${pct(c.difference)} (${escapeHtml(Math.round(c.confidence * 100))}% CI ${pct(lo)} to ${pct(hi)})</dd>`;
}

function judgementBlock(jg: Json | undefined): string {
	if (!jg) return "";
	const items = (jg.criteria ?? [])
		.map(
			(v: Json) =>
				`<li>${badge(v.pass ? "pass" : "fail", v.pass ? "pass" : "FAIL")} <code>${escapeHtml(v.id)}</code> ${escapeHtml(v.reason)}</li>`,
		)
		.join("");
	return `<dt>judgement</dt><dd>${badge(jg.pass ? "pass" : "fail", jg.pass ? "pass" : "fail")}<ul>${items}</ul></dd>`;
}

function runBlock(run: Json | undefined): string {
	if (!run || typeof run !== "object") return "";
	const head = `exit ${escapeHtml(run.exitCode ?? "?")}${run.timedOut ? ", timed out" : ""}${typeof run.durationMs === "number" ? `, ${Math.round(run.durationMs)} ms` : ""}`;
	const pre = (label: string, v: unknown): string =>
		typeof v === "string" && v ? `<details><summary>${label}</summary><pre>${escapeHtml(v)}</pre></details>` : "";
	return `<dt>run</dt><dd>${head}${pre("stdout", run.stdout)}${pre("stderr", run.stderr)}</dd>`;
}

function table(head: string[], rows: string[][]): string {
	if (!rows.length) return "<p class=muted>none</p>";
	const th = head.map((h) => `<th>${h}</th>`).join("");
	const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
	return `<div class=scroll><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function traceBlock(r: SavedResult): string {
	const trace = r.json.trace as Json | undefined;
	if (!trace) return "";
	const events: Json[] = trace.events ?? [];
	const requests: Json[] = trace.requests ?? [];
	const eventRows = events.map((e) => [
		escapeHtml(e.seq),
		cut(e.agent),
		escapeHtml(e.kind),
		cut(e.name),
		cut(e.args),
		cut(e.data),
	]);
	const requestRows = requests.map((q) => [
		escapeHtml(q.index),
		cut(q.agent),
		cut(q.model),
		escapeHtml(q.bytes),
		cut(q.usage),
		cut(q.messages?.at?.(-1)?.content),
	]);
	const raw = JSON.stringify(trace, null, 2);
	const note =
		raw.length > RAW_MAX
			? `<p class=muted>Cut at ${RAW_MAX} characters; the full JSON is in ${escapeHtml(r.path)}.</p>`
			: "";
	return `<details><summary>Trace: ${events.length} events, ${requests.length} requests</summary>
<h4>Events</h4>${table(["seq", "agent", "kind", "name", "args", "data"], eventRows)}
<h4>Requests</h4>${table(["index", "agent", "model", "bytes", "usage", "last message"], requestRows)}
<details><summary>Raw trace JSON</summary>${note}<pre>${escapeHtml(raw.slice(0, RAW_MAX))}</pre></details>
</details>`;
}

const LABEL: Record<Status, string> = { fail: "fail", checks: "checks failed", pass: "pass", other: "" };

function resultSection(r: SavedResult, i: number): string {
	const s = r.summary;
	const status = statusOf(r);
	const failed = s.failedChecks ? `<dt>failed checks</dt><dd>${escapeHtml(s.failedChecks.join(", "))}</dd>` : "";
	const note = r.json.note ? `<dt>note</dt><dd>${escapeHtml(r.json.note)}</dd>` : "";
	return `<section class="result ${status}" id="r${i}">
<h3>${badge(status, LABEL[status] || s.state)} ${escapeHtml(s.test)}</h3>
<p class=muted>${escapeHtml(s.file)} · saved ${escapeHtml(r.json.savedAt)} · ${escapeHtml(r.path)}</p>
<dl><dt>state</dt><dd>${escapeHtml(s.state)}</dd>${failed}<dt>requests</dt><dd>${s.requests}</dd><dt>tool calls</dt><dd>${toolSequence(r.json)}</dd>${liveBlock(r.json.live)}${compareBlock(r.json.compare)}${judgementBlock(r.json.judgement)}${note}${runBlock(r.json.run)}</dl>
${traceBlock(r)}
</section>`;
}

/** A test that failed or passed fewer runs than it needed. */
const isFailing = (x: AgentReport["tests"][number]): boolean => x.state === "failed" || x.passes < x.needed;

function agentReportBlock(dir: string): string {
	const file = join(dir, AGENT_REPORT_FILE);
	if (!existsSync(file)) return "";
	const report = JSON.parse(readFileSync(file, "utf8")) as AgentReport;
	const t = report.totals;
	const tests = report.tests.toSorted((a, b) => Number(isFailing(b)) - Number(isFailing(a)));
	const rows = tests.map((x) => [
		badge(isFailing(x) ? "fail" : "pass", x.state),
		escapeHtml(x.test),
		`${x.passes}/${x.runs} (need ${x.needed})`,
		`${pct(x.interval[0])} to ${pct(x.interval[1])}`,
		escapeHtml(x.requests),
		`$${x.costUsd.toFixed(4)}`,
		escapeHtml(x.trajectories.map((tr) => tr.join(" → ")).join(" | ")),
	]);
	const coverage =
		t.toolCoverage === null
			? "no mock tools"
			: `${pct(t.toolCoverage)} of mock tools executed${t.neverExecuted.length ? `; never: ${escapeHtml(t.neverExecuted.join(", "))}` : ""}`;
	return `<section class=report><h2>Agent report</h2>
<p>${t.tests} suite tests · ${coverage} · skills: ${escapeHtml(t.skills.join(", ") || "none")} · guards fired: ${t.guards} · spend $${t.costUsd.toFixed(4)}</p>
${table(["state", "test", "passes", "95% CI", "requests", "cost", "tool sequence per run"], rows)}</section>`;
}

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--muted:#59636e;--line:#d1d9e0;--panel:#f6f8fa;--fail:#cf222e;--warn:#9a6700;--pass:#1a7f37}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--panel:#151b23;--fail:#ff7b72;--warn:#d29922;--pass:#3fb950}}
body{margin:0 auto;max-width:72rem;padding:1rem;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
a{color:inherit}.muted{color:var(--muted)}code,pre,td{font-family:ui-monospace,monospace;font-size:12px}
pre{background:var(--panel);border:1px solid var(--line);padding:.5rem;overflow:auto;white-space:pre-wrap;word-break:break-word}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--line);padding:2px 6px;text-align:left;vertical-align:top;word-break:break-word}
section{border:1px solid var(--line);border-left-width:4px;border-radius:6px;padding:.25rem 1rem;margin:1rem 0;background:var(--panel)}
section.fail{border-left-color:var(--fail)}section.checks{border-left-color:var(--warn)}section.pass{border-left-color:var(--pass)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 1rem}dt{color:var(--muted)}dd{margin:0}
.badge{display:inline-block;border-radius:4px;padding:0 6px;font-size:12px;color:var(--bg);background:var(--muted)}
.badge.fail{background:var(--fail)}.badge.checks{background:var(--warn)}.badge.pass{background:var(--pass)}summary{cursor:pointer}`;

/**
 * One self-contained HTML page for the results saved under `dir`: failures first, then per test its status, live and
 * comparison summaries, judgement, request count, tool-call sequence and an expandable trace. Reads the agent report
 * (`testkit-agent-report.json`) in `dir` when present. No scripts and no external resources; all content is escaped.
 */
export function renderResultsHtml(dir: string): string {
	const results = loadResults(dir);
	const failing = results.filter((r) => statusOf(r) === "fail" || statusOf(r) === "checks").length;
	const index = results
		.map((r, i) => {
			const st = statusOf(r);
			return `<li>${badge(st, LABEL[st] || r.summary.state)} <a href="#r${i}">${escapeHtml(r.summary.file)} › ${escapeHtml(r.summary.test)}</a></li>`;
		})
		.join("");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Testkit results</title><style>${CSS}</style></head>
<body><h1>Testkit results</h1>
<p class=muted>${escapeHtml(dir)} · ${results.length} results, ${failing} failing</p>
${agentReportBlock(dir)}
<h2>Results</h2>${results.length ? `<ol>${index}</ol>` : "<p class=muted>No saved results.</p>"}
${results.map(resultSection).join("\n")}
</body></html>
`;
}
