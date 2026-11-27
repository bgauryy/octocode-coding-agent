import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Reporter, TestModule } from "vitest/node";
import { cacheDir } from "./cache-report.ts";
import type { SuiteMeta } from "./suite-meta.ts";

export interface AgentReport {
	totals: {
		tests: number;
		costUsd: number;
		/** Share of advertised mock tools some test executed; null without mock servers. */
		toolCoverage: number | null;
		/** Advertised `server.tool` no test executed. */
		neverExecuted: string[];
		skills: string[];
		guards: number;
	};
	tests: ({ test: string; state: string } & SuiteMeta)[];
}

/** Builds the report from finished test modules: every test that `agentSuite` ran. */
export function agentReport(modules: ReadonlyArray<TestModule>): AgentReport {
	const tests: AgentReport["tests"] = [];
	for (const m of modules)
		for (const tc of m.children.allTests()) {
			const meta = tc.meta().agentSuite;
			if (meta) tests.push({ test: tc.fullName, state: tc.result().state, ...meta });
		}
	const advertised = new Set(tests.flatMap((t) => t.toolsAdvertised));
	const executed = new Set(tests.flatMap((t) => t.toolsExecuted).filter((x) => advertised.has(x)));
	return {
		totals: {
			tests: tests.length,
			costUsd: tests.reduce((n, t) => n + t.costUsd, 0),
			toolCoverage: advertised.size ? executed.size / advertised.size : null,
			neverExecuted: [...advertised].filter((x) => !executed.has(x)).toSorted(),
			skills: [...new Set(tests.flatMap((t) => t.skills))].toSorted(),
			guards: tests.reduce((n, t) => n + t.guards.length, 0),
		},
		tests,
	};
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** The report as terminal lines: one per test, then coverage and spend. */
export function formatAgentReport(r: AgentReport): string {
	const lines = r.tests.map((t) => {
		const [lo, hi] = t.interval;
		const mark = t.passes >= t.needed ? "✓" : "✗";
		const expected = t.state === "passed" && t.passes < t.needed ? " (expected to fail)" : "";
		return `  ${mark} ${t.test}${expected}  ${t.passes}/${t.runs} (95% CI ${pct(lo)}–${pct(hi)})  ${t.requests} req  $${t.costUsd.toFixed(4)}`;
	});
	const { totals } = r;
	const coverage =
		totals.toolCoverage === null
			? "no mock tools"
			: `${pct(totals.toolCoverage)} of mock tools executed${totals.neverExecuted.length ? ` · never: ${totals.neverExecuted.join(", ")}` : ""}`;
	return [
		"Agent behavior",
		...lines,
		`  tools: ${coverage}`,
		`  skills loaded: ${totals.skills.join(", ") || "none"} · guards fired: ${totals.guards}`,
		`  spend: $${totals.costUsd.toFixed(4)}`,
	].join("\n");
}

/**
 * Vitest reporter for `agentSuite` tests: pass rate with its Wilson interval, requests and spend per test, and the
 * coverage code coverage cannot see: which advertised mock tools some test executed. Writes the JSON report to
 * `outputFile` (default `<TESTKIT_REPORT_DIR>/testkit-agent-report.json`) and prints a summary; silent when no
 * suite test ran.
 */
export default class AgentReporter implements Reporter {
	private readonly outputFile?: string;

	constructor(opts: { outputFile?: string } = {}) {
		this.outputFile = opts.outputFile;
	}

	onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
		const report = agentReport(modules);
		if (!report.tests.length) return;
		const file = this.outputFile ?? join(cacheDir(), "testkit-agent-report.json");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
		process.stdout.write(`\n${formatAgentReport(report)}\n  report: ${file}\n`);
	}
}
