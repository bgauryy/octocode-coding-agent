import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
	branchLines,
	CONFIGS,
	KINDS,
	percentile,
	quiet,
	record,
	rigFor,
	sendKind,
	sentText,
	sleep,
	tail,
	tokens,
	type Rig,
} from "./lib.ts";

/**
 * R13: a burst, the per-kind tail, and the latency of typed input, on a scripted model (no network, no spend). Each case
 * records numbers (`R13_OUT`) and asserts only what must hold for any scheduler: every event reaches the conversation once.
 */
const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
});
const replies = (rig: Rig, n: number) => Array.from({ length: n }, (_, i) => rig.reply(`ok ${i}`));

describe.each(CONFIGS)("$name", (config) => {
	it("a burst of 5 job exits and 2 child reports: turns, tail, duplicates", async () => {
		const rig = await rigFor(config);
		rigs.push(rig);
		rig.harness.setResponses(replies(rig, 12));
		const events = [
			...Array.from({ length: 5 }, (_, i) => ({ kind: KINDS[0], id: `JOB${i}` })),
			...Array.from({ length: 2 }, (_, i) => ({ kind: KINDS[4], id: `REP${i}` })),
		];
		const started = performance.now();
		const sends: Array<void | Promise<unknown>> = [];
		for (const [i, { kind, id }] of events.entries()) {
			const event =
				kind.event.kind === "job.exit" ? { ...kind.event, job: `bash-${id}` } : { ...kind.event, reportId: id };
			sends.push(sendKind(rig, { ...kind, event }, id));
			await sleep(25 * (i % 2));
		}
		await Promise.all(sends);
		await quiet(rig, { marker: "", lines: events.length });
		const settledMs = performance.now() - started;
		const branch = branchLines(rig.harness);
		for (const { id } of events)
			expect(branch.filter((l) => l.startsWith("custom:") && l.includes(id))).toHaveLength(1);
		const added = tail(rig, "");
		const sent = events.reduce((sum, { kind, id }) => sum + tokens(`${id} ${sentText(kind)}`), 0);
		record("burst", config, {
			events: events.length,
			wakeTurns: rig.requests.length,
			coalesced: events.length - rig.requests.length,
			delivered: added.lines,
			tailTokens: added.tokens,
			sentTokens: sent,
			framingTokens: added.tokens - sent,
			settledMs: Math.round(settledMs),
		});
	}, 60_000);

	it.each(KINDS.map((kind) => [kind.name, kind] as const))(
		"one %s: framing tokens and turns",
		async (_name, kind) => {
			const rig = await rigFor(config);
			rigs.push(rig);
			rig.harness.setResponses(replies(rig, 3));
			await sendKind(rig, kind, "MARK");
			await quiet(rig, { marker: "MARK", lines: 1 });
			const added = tail(rig, "MARK");
			const sent = tokens(`MARK ${sentText(kind)}`);
			expect(added.lines).toBe(1);
			record("kind", config, {
				kind: kind.name,
				wakeTurns: rig.requests.length,
				sentTokens: sent,
				tailTokens: added.tokens,
				framingTokens: added.tokens - sent,
			});
		},
		30_000,
	);

	it.each([
		["idle", false],
		["while an event holds a window open", true],
	])(
		"Q1 typed input %s: time to the model's first request",
		async (label, withEvent) => {
			const rig = await rigFor(config);
			rigs.push(rig);
			const trials = 20;
			const samples: number[] = [];
			let firstRequest = 0;
			for (let i = 0; i < trials; i++) {
				const reply = rig.reply(`ok ${i}`);
				rig.harness.setResponses([
					(context) => {
						firstRequest ||= performance.now();
						return reply(context);
					},
					...replies(rig, 2),
				]);
				firstRequest = 0;
				if (withEvent) {
					void sendKind(rig, KINDS[0], `Q1-${i}`);
					await sleep(20);
				}
				const typed = performance.now();
				await rig.harness.session.prompt(`typed ${i}`);
				samples.push(firstRequest - typed);
				await quiet(rig);
			}
			samples.sort((a, b) => a - b);
			record("q1", config, {
				case: label,
				trials,
				p50Ms: +percentile(samples, 50).toFixed(2),
				p95Ms: +percentile(samples, 95).toFixed(2),
			});
		},
		120_000,
	);
});
