import { describe, expect, it } from "vitest";
import type { Responder } from "../../src/gateway.ts";
import type { Step } from "../../src/script.ts";
import { type CapturedRequest, textOf } from "../../src/trace.ts";
import { gateway } from "../helpers.ts";
import { block, position, runFlow, type FlowRun } from "./context-flows.ts";
import { requireBundle } from "./support.ts";

/**
 * Repeated compaction keeps what the work stands on. One session compacts four times, each at a task boundary (the
 * agent's `compact` tool), with a standing rule, a second rule the user lifts later, an open item and a decision per
 * cycle. The scripted summarizer drops the standing rule twice, the way real summaries let rules drift out; what the
 * model reads after each compaction must still carry the rule word for word, the open item and the latest decision.
 * Judged only from the requests on the wire, so it holds for any agent that keeps a checkpoint.
 */

const RULE = "Never commit; leave every change uncommitted.";
const LIFTED_RULE = "Ask before deleting files.";
const ITEM = "B7: migrate the parser to the new lexer";
const decision = (cycle: number) => `**Decision ${cycle}**: keep parser step ${cycle} behind its flag`;
const CYCLES = 4;
/** The cycle whose summary lifts the second rule, after the user lifted it in that turn. */
const LIFT_AT = 3;
/** Cycles whose summary leaves the standing rule out, as a drifting summarizer does. */
const DROPS_RULE = new Set([2, 4]);

const SUMMARY_MARKER = "write a context checkpoint summary";
const RESUME_MARKER = "[Compaction] The compaction you requested is done";

/** What the scripted summarizer writes at `cycle`: only that cycle's news, like an update that drifts. */
function summaryText(cycle: number): string {
	const constraints =
		cycle === 1
			? [`- ${RULE}`, `- ${LIFTED_RULE}`]
			: [
					...(DROPS_RULE.has(cycle) ? [] : [`- ${RULE}`]),
					...(cycle === LIFT_AT ? ["- Lifted [C2]: the user allowed deleting files in T3"] : []),
				];
	return [
		`## Goal\nFinish the parser migration (cycle ${cycle})`,
		`## Constraints & Preferences\n${constraints.length > 0 ? constraints.join("\n") : "- (none)"}`,
		`## Progress\n### Done\n- [x] step ${cycle}\n\n### In Progress\n- [ ] ${ITEM}`,
		`## Key Decisions\n- ${decision(cycle)}`,
		`## Where We Stopped\n- after step ${cycle}`,
		`## TL;DR\nStep ${cycle} of the parser migration.\nTopics: parser, lexer, migration`,
	].join("\n\n");
}

const lastUserText = (request: CapturedRequest): string =>
	textOf(request.messages.findLast((message) => message.role === "user")?.content);

/** The lines of the `## <heading>` section of `text`, up to the next `## ` heading or tag line. */
function section(text: string, heading: string): string[] {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
	if (start < 0) return [];
	const end = lines.findIndex((line, index) => index > start && /^(?:## |<)/.test(line));
	return lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.trim());
}

interface FidelityRun {
	run: FlowRun;
	/** The summary requests in order, and what the summarizer answered each. */
	summaries: Array<{ request: CapturedRequest; reply: string }>;
	/** The first main request after each compaction: what the model reads once it resumed. */
	resumed: CapturedRequest[];
}

/**
 * Each turn: a short tool call, then `compact` with a focus, then a status line; after the compaction the hidden resume
 * message starts one more request, which is the one judged. The tool call keeps two turns between compactions, so the
 * tool's cooldown and the refill breaker never refuse one.
 */
function fidelityResponder(): {
	responder: Responder;
	summaries: FidelityRun["summaries"];
	resumed: CapturedRequest[];
} {
	const summaries: FidelityRun["summaries"] = [];
	const resumed: CapturedRequest[] = [];
	const responder: Responder = ({ request }) => {
		const last = lastUserText(request);
		if (request.tools.length === 0 || last.includes(SUMMARY_MARKER)) {
			const reply = summaryText(summaries.length + 1);
			summaries.push({ request, reply });
			return { text: reply };
		}
		if (last.includes(RESUME_MARKER)) {
			resumed.push(request);
			return { text: "resumed from the checkpoint" };
		}
		const { turn, replies } = position(request);
		if (turn === "T0") return { text: "T0 ready" };
		const steps: Step[] = [
			{ toolCalls: [{ name: "bash", args: { command: `echo ${turn} noted` } }] },
			{ toolCalls: [{ name: "compact", args: { focus: `next: continue ${ITEM}` } }] },
			{ text: `${turn} paused at a task boundary` },
		];
		return steps[replies] ?? { text: `${turn} done` };
	};
	return { responder, summaries, resumed };
}

/** One run serves every test here: it is a whole session of four compactions. */
let shared: Promise<FidelityRun> | undefined;

async function fidelityRun(): Promise<FidelityRun> {
	const script = fidelityResponder();
	const gw = await gateway({ responder: script.responder });
	try {
		// Sizes, for a 140k window (126k budget, 110k usable, `compact` refused under 55k, the early summary planned
		// past about 97k estimated): the prompt is about 70 KB. T0 gives the first usage, so T1 is not judged by the
		// denser pre-request estimate alone. T1 brings 160 KB and each later turn 80 KB: every `compact` lands at 55-80k
		// tokens of usage, and every request before it stays under the early-summary lead, so each compaction writes
		// exactly one summary. Each compaction keeps the newest turn's filler (over the 20k kept-token tail alone).
		const filler = (tag: string, kilobytes: number) => block(tag, Math.round((kilobytes * 1024) / 400));
		const run = await runFlow(gw, {
			turns: [
				"T0 Hello, we start on the parser today.",
				`T1 Standing rule: ${RULE} Also: ${LIFTED_RULE} Open item: ${ITEM}. ${filler("FILL-T1", 160)}`,
				`T2 Continue with the parser. ${filler("FILL-T2", 80)}`,
				`T3 You may delete files now, no need to ask. ${filler("FILL-T3", 80)}`,
				`T4 Continue with the parser. ${filler("FILL-T4", 80)}`,
			],
			files: {},
			contextWindow: 140_000,
		});
		return { run, summaries: script.summaries, resumed: script.resumed };
	} finally {
		await gw.close();
	}
}

/** The checkpoint as the model reads it in `request`: the compaction summary message's text. */
function checkpointOf(request: CapturedRequest | undefined): string {
	return textOf(
		request?.messages.find((message) => textOf(message.content).includes("## Constraints & Preferences"))?.content,
	);
}

describe("repeated compaction fidelity (octocode-agent)", () => {
	it("keeps the standing rule word for word, the open item and the latest decision through four compactions", async (ctx) => {
		requireBundle(ctx);
		const { run, summaries, resumed } = await (shared ??= fidelityRun());
		expect(run.exitCode, run.stderr.slice(-2000)).toBe(0);
		expect(summaries.length, "one summary per compaction").toBe(CYCLES);
		expect(resumed.length, "a resumed request after each compaction").toBe(CYCLES);
		for (let cycle = 1; cycle <= CYCLES; cycle++) {
			const checkpoint = checkpointOf(resumed[cycle - 1]);
			const constraints = section(checkpoint, "Constraints & Preferences");
			expect(constraints, `cycle ${cycle}: the standing rule, verbatim`).toContainEqual(expect.stringContaining(RULE));
			if (cycle < LIFT_AT)
				expect(constraints, `cycle ${cycle}: the second rule`).toContainEqual(expect.stringContaining(LIFTED_RULE));
			else expect(constraints.join("\n"), `cycle ${cycle}: the lifted rule is gone`).not.toContain(LIFTED_RULE);
			expect(section(checkpoint, "Progress").join("\n"), `cycle ${cycle}: the open item`).toContain(ITEM);
			expect(section(checkpoint, "Key Decisions").join("\n"), `cycle ${cycle}: the latest decision`).toContain(
				decision(cycle),
			);
		}
	});

	it("probe: a summary that drops the standing rule is shown the rule, and the next request still carries it", async (ctx) => {
		requireBundle(ctx);
		const { summaries, resumed } = await (shared ??= fidelityRun());
		for (const cycle of DROPS_RULE) {
			const summary = summaries[cycle - 1];
			if (!summary) throw new Error(`no summary was asked for at cycle ${cycle}`);
			// The summarizer really left the rule out of its constraints...
			expect(section(summary.reply, "Constraints & Preferences").join("\n")).not.toContain(RULE);
			// ...after the request named it as carried, so it could have been lifted only on purpose.
			expect(lastUserText(summary.request)).toContain(RULE);
			// The checkpoint the model reads next still states it, word for word.
			expect(section(checkpointOf(resumed[cycle - 1]), "Constraints & Preferences")).toContainEqual(
				expect.stringContaining(RULE),
			);
		}
	});
});
