import { performance } from "node:perf_hooks";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { gateSummary } from "../loop-characterization/summary-gate.ts";
import { branchLines, CONFIGS, exitEvent, quiet, record, rigFor, sleep, tokens, type Rig, wakeGateOf } from "./lib.ts";

/**
 * R13: events that arrive while a manual `/compact` holds its summary. Each queued event must reach the conversation once,
 * after the compaction entry; the record is how many were queued (depth bucket), how long the lock was held, how long the
 * drain took after the summary was saved, and how many turns it cost.
 */
const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
});
const bucket = (depth: number) => (depth < 10 ? "0-10" : depth < 50 ? "10-50" : "50+");
const LOCK_MS = 300;

describe.each(CONFIGS)("$name", (config) => {
	it.each([5, 30, 80])(
		"%i events queued during the compaction lock",
		async (depth) => {
			const rig = await rigFor(config, {
				models: [{ id: "faux-1", contextWindow: 8000, maxTokens: 100 }],
				compactionPolicy: { enabled: true, reserveTokens: 400, keepRecentTokens: 1 },
			});
			rigs.push(rig);
			rig.harness.setResponses([
				...Array.from({ length: 4 }, (_, i) => fauxAssistantMessage(`s${i}:${"a".repeat(1500)}`)),
				...Array.from({ length: depth + 3 }, (_, i) => rig.reply(`ok ${i}`)),
			]);
			for (let i = 0; i < 4; i++) await rig.harness.session.prompt(`seed ${i}`);
			rig.requests.length = 0;
			const gate = gateSummary(rig.harness.session);
			const locked = performance.now();
			const compacting = rig.harness.session.compact();
			await Promise.race([gate.started, compacting]);
			const sends: Array<unknown> = [];
			for (let i = 0; i < depth; i++) {
				sends.push(
					wakeGateOf(rig.api).emit(
						exitEvent(`bash-${i}`),
						{ customType: "r13", content: `LOCK${i}X job ${i} finished`, display: true },
						{ triggerTurn: true, deliverAs: "followUp", together: true },
					),
				);
			}
			await sleep(LOCK_MS);
			gate.release();
			await compacting;
			const lockedMs = performance.now() - locked;
			const released = performance.now();
			await Promise.all(sends);
			const lines = () =>
				branchLines(rig.harness).filter((line) => line.startsWith("custom:") && line.includes("X job"));
			const until = Date.now() + 15_000;
			while (lines().length < depth && Date.now() < until) await sleep(10);
			const drainMs = performance.now() - released;
			await quiet(rig);
			const branch = branchLines(rig.harness);
			const compaction = branch.indexOf("compaction");
			let duplicates = 0;
			let lost = 0;
			let before = 0;
			for (let i = 0; i < depth; i++) {
				const hits = branch.filter((line) => line.includes(`LOCK${i}X`));
				if (hits.length === 0) lost++;
				if (hits.length > 1) duplicates++;
				if (hits.length > 0 && branch.findIndex((line) => line.includes(`LOCK${i}X`)) < compaction) before++;
			}
			record("lock", config, {
				depth,
				bucket: bucket(depth),
				lockMs: Math.round(lockedMs),
				drainMs: Math.round(drainMs),
				wakeTurns: rig.requests.length,
				lost,
				duplicates,
				beforeCompaction: before,
				tailTokens: lines().reduce((sum, line) => sum + tokens(line), 0),
			});
			expect({ lost, duplicates, before }).toEqual({ lost: 0, duplicates: 0, before: 0 });
		},
		90_000,
	);
});
