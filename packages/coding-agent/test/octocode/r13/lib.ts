import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderPrompt } from "../../../src/core/prompt-template.ts";
import { shortPath } from "../../../src/utils/display-path.ts";
import { jobReport } from "../../../src/octocode/files/bash-jobs/report.ts";
import type { BashJob } from "../../../src/octocode/files/bash-jobs/types.ts";
import { wakeText } from "../../../src/octocode/timer/model.ts";
import { appendHead, emptyHead, headPreview } from "../../../src/octocode/subagents/report-head.ts";
import type { TimerRow } from "../../../../db/src/api.ts";
import { branchLines, createRig, wakeGateOf, type Rig, type RigOptions } from "../loop-characterization/rig.ts";
import { reportDigest } from "../../../src/octocode/subagents/report-digest.ts";
import type { AgentEvent } from "../../../src/octocode/wake/catalog.ts";

/**
 * Shared parts of the R13 measurements (RFC agent-event-loop §10, R13). The same files run on the tree that still has the
 * wake gate's own scheduler (commit e77a2ed20, `runtime.eventLoop: old`) and on the one where the event loop is the only scheduler, so a
 * scenario never names a scheduler: `R13_CONFIGS` (JSON) lists the settings each configuration runs with.
 */
export interface Config {
	name: string;
	/** Merged into the session's settings (`runtime`, `subagents`). */
	settings: Record<string, Record<string, unknown>>;
}

export const CONFIGS: Config[] = JSON.parse(
	process.env.R13_CONFIGS ??
		JSON.stringify([
			{ name: "loop window 0 s", settings: { runtime: { eventWindowSeconds: 0 } } },
			{ name: "loop window 2 s", settings: { runtime: { eventWindowSeconds: 2 } } },
		]),
);

/** Where results are appended, one JSON line each; unset means the run only asserts. */
export function record(scenario: string, config: Config, data: Record<string, unknown>): void {
	const file = process.env.R13_OUT;
	if (file) appendFileSync(file, `${JSON.stringify({ scenario, config: config.name, ...data })}\n`);
}

/** The tokens of a text: 4 characters each, the estimate the RFC uses (no tokenizer, so the same for both schedulers). */
export const tokens = (text: string): number => Math.ceil(text.length / 4);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export async function rigFor(config: Config, options: RigOptions = {}): Promise<Rig> {
	return createRig({
		...options,
		settings: {
			...options.settings,
			...Object.fromEntries(
				Object.entries(config.settings).map(([key, value]) => [
					key,
					{ ...(options.settings as Record<string, object> | undefined)?.[key], ...value },
				]),
			),
		},
	});
}

export const exitEvent = (job: string, exit = 0): AgentEvent => ({
	kind: "job.exit",
	job,
	exit,
	durationMs: 1,
	startedAt: 0,
});

export interface Kind {
	name: string;
	event: AgentEvent;
	/** What the producer sends as the message text (the loop and the gate do not change it). */
	text: string;
	/** The producer starts no turn for it (a success nobody awaits is recorded only). */
	quiet?: boolean;
	/** The producer's full text is saved there and the message carries `reportDigest` of it. */
	file?: string;
}

const filler = (words: number) => Array.from({ length: words }, (_, i) => `line${i}`).join(" ");

/**
 * The texts below come from the producers' own code (`jobReport`, `wakeText`, the report head and pointer, `reportDigest`),
 * so a producer change moves the numbers. Two are still written here because their producer is not callable alone: a
 * backlog change line and a team mail body.
 */
const dir = mkdtempSync(path.join(tmpdir(), "r13-lib-"));
function jobText(id: string, code: number, digest: boolean): string {
	const log = path.join(dir, `${id}.log`);
	writeFileSync(log, `${Array.from({ length: 12 }, (_, i) => `test ${i}: ${filler(9)}`).join("\n")}\n`);
	const job = { id, command: "yarn test", cwd: dir, pid: 1, log, startedAt: 0, done: Promise.resolve({}) } as BashJob;
	return jobReport(job, { code, signal: null, seconds: 1 }, digest);
}

const reportBody = (() => {
	const head = appendHead(
		emptyHead(),
		`done: the work is finished.\n${Array.from({ length: 150 }, (_, i) => `finding ${i}: ${filler(10)}`).join("\n")}`,
	);
	return headPreview(head);
})();
const reportFile = path.join(dir, "report-a.md");
const reportText = `${reportBody}\n${renderPrompt("notices/subagents/report-pointer.md", { partial: false, file: shortPath(reportFile) })}`;

const timerRow = {
	id: 3,
	note: `check ${filler(40)}`,
	kind: "once",
	status: "done",
	runs: 1,
	max_runs: null,
	last_exit: null,
	last_output: null,
	condition_kind: null,
	checks: 0,
	spent_usd: 0,
} as unknown as TimerRow;

/** One representative event per kind of RFC §10.1. */
export const KINDS: Kind[] = [
	{
		name: "job exit, success, nobody waits",
		event: exitEvent("bash-1"),
		text: jobText("bash-1", 0, true),
		quiet: true,
	},
	{
		name: "job failed",
		event: exitEvent("bash-2", 1),
		text: jobText("bash-2", 1, false),
	},
	{
		name: "timer fires",
		event: { kind: "time.due", timerId: 3, run: 1, note: "check" },
		text: wakeText(timerRow),
	},
	{
		name: "backlog change",
		event: { kind: "item.peer", ref: "B7", change: "done", by: "agent", relation: "dep", id: 1 },
		text: `B7 moved to done by agent\n${filler(35)}`,
	},
	{
		name: "child report",
		event: { kind: "agent.report", agent: "a", role: "implementer", outcome: "done", reportId: "r1" },
		text: reportText,
		file: reportFile,
	},
	{
		name: "team mail",
		event: { kind: "agent.message", from: "a", id: 4, replyRequired: false, interrupt: false },
		text: `Message from a: ${filler(60)}`,
	},
];

/** What the message carries of a kind's text. */
export const sentText = (kind: Kind): string => (kind.file ? reportDigest(kind.text, kind.file) : kind.text);

export function sendKind(rig: Rig, kind: Kind, marker: string) {
	return wakeGateOf(rig.api).emit(
		kind.event,
		{ customType: "r13", content: `${marker} ${sentText(kind)}`, display: true },
		{ triggerTurn: !kind.quiet, deliverAs: "followUp", together: true },
	);
}

/** The tail the events added to the conversation: the custom lines of the branch, in tokens and in lines. */
export function tail(rig: Rig, marker: string): { tokens: number; lines: number } {
	const lines = branchLines(rig.harness).filter((line) => line.startsWith("custom:") && line.includes(marker));
	return { tokens: lines.reduce((sum, line) => sum + tokens(line), 0), lines: lines.length };
}

/**
 * Waits until nothing is running and nothing new started for two checks. A producer's receipt resolves when its message is
 * sent, so every held event has been sent before this is called; this only lets the turn it started end. It uses the
 * session alone, so it works on every tree the measurement runs on.
 */
export async function quiet(rig: Rig, delivered?: { marker: string; lines: number }): Promise<void> {
	// A held event is delivered when its window ends, which can be after the producer's receipt resolved.
	const until = Date.now() + 10_000;
	while (delivered && tail(rig, delivered.marker).lines < delivered.lines && Date.now() < until) await sleep(20);
	let calm = 0;
	let seen = rig.requests.length;
	while (calm < 2) {
		await rig.harness.session.waitForIdle();
		await sleep(30);
		const now = rig.requests.length;
		calm = now === seen && !rig.harness.session.isStreaming ? calm + 1 : 0;
		seen = now;
	}
}

export { branchLines, wakeGateOf };
export type { Rig };
