import { type AssistantMessage, fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, expect, it } from "vitest";
import type { CompactionEntry } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Standing constraints and decisions survive repeated compaction by construction: the summarizer here forgets every
 * carried bullet (the drift measured in real sessions), restates one in other words (once with its id, once without),
 * and lifts one rule and supersedes one decision. After each of six compactions every bullet not lifted is still in the
 * checkpoint word for word, once, the lifted ones are gone, recorded with their reasons, and the entry counts the ledger.
 */

let harness: Harness | undefined;

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

const CYCLES = 6;
const LIFT_AT = 4;
const SUPERSEDE_AT = 5;
const rule = (cycle: number) => `Rule from request ${cycle}: never touch src/file${cycle}.ts without asking.`;
const decision = (cycle: number) => `**Decision ${cycle}**: keep parser ${cycle} because test ${cycle} pins it.`;

const promptOf = (context: { messages: Array<{ content: unknown }> }): string =>
	JSON.stringify(context.messages.map((message) => message.content));

/** A summarizer that keeps nothing it was told is carried, and writes only what is new in this cycle. */
function forgetfulSummary(cycle: number): (context: { messages: Array<{ content: unknown }> }) => AssistantMessage {
	return (context) => {
		const prompt = promptOf(context);
		if (prompt.includes("# Instructions")) return fauxAssistantMessage("### Original Request\n- continue");
		const constraints = [
			`- ${rule(cycle)}`,
			// Restated in other words with its id: code keeps the carried text, not this one.
			...(cycle === 2 ? ["- [C1] Rule one, reworded by the summarizer."] : []),
			// Restated in other words without its id: the same rule, so it is not added again.
			...(cycle === 3 ? ["- Rule from request 1: never touch src/file1.ts unless asking."] : []),
			...(cycle === LIFT_AT ? ["- Lifted [C2]: the user allowed touching src/file2.ts in request 4"] : []),
		];
		const decisions = [
			`- ${decision(cycle)}`,
			...(cycle === SUPERSEDE_AT ? ["- Superseded [D1]: decision 5 replaced it"] : []),
		];
		return fauxAssistantMessage(
			[
				`## Goal\nGoal of request ${cycle}`,
				`## Constraints & Preferences\n${constraints.join("\n")}`,
				"## Progress\n### Done\n- [x] request handled",
				`## Key Decisions\n${decisions.join("\n")}`,
				`## Where We Stopped\n- after request ${cycle}`,
				`## TL;DR\nHandled request ${cycle}.\nTopics: parser, rules, request`,
			].join("\n\n"),
		);
	};
}

it("keeps every constraint and decision not lifted through six repeated compactions, and drops the lifted ones", async () => {
	harness = await createHarness({ compactionPolicy: { keepRecentTokens: 15 } });
	const { sessionManager } = harness;
	const prompts: string[] = [];
	for (let cycle = 1; cycle <= CYCLES; cycle++) {
		sessionManager.appendMessage({
			role: "user",
			content: `Request ${cycle}: ${"detail ".repeat(250)}`,
			timestamp: Date.now(),
		});
		sessionManager.appendMessage(fauxAssistantMessage(`Result ${cycle}: ${"evidence ".repeat(200)}`));
		// A short turn the compaction keeps, so it summarizes whole turns.
		sessionManager.appendMessage({ role: "user", content: `next request ${cycle}, please`, timestamp: Date.now() });
		sessionManager.appendMessage(fauxAssistantMessage(`ready for request ${cycle}`));
		harness.session.refreshContext();
		const summarize = forgetfulSummary(cycle);
		harness.setResponses([
			(context) => {
				prompts[cycle] = promptOf(context);
				return summarize(context);
			},
			summarize,
		]);
		await harness.session.compact();

		const entries = sessionManager
			.getEntries()
			.filter((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(entries).toHaveLength(cycle);
		const latest = entries[entries.length - 1];
		const summary = latest.summary;
		// Every rule written so far survives verbatim with its id, except the one lifted at cycle 4.
		for (let written = 1; written <= cycle; written++) {
			const lifted = written === 2 && cycle >= LIFT_AT;
			if (lifted) expect(summary).not.toContain(rule(written));
			else expect(summary).toContain(rule(written));
			const superseded = written === 1 && cycle >= SUPERSEDE_AT;
			if (superseded) expect(summary).not.toContain(decision(written));
			else expect(summary).toContain(decision(written));
		}
		expect(summary).toContain(`- [C1] ${rule(1)}`);
		expect(summary).not.toContain("Rule one, reworded");
		expect(summary).not.toContain("unless asking");
		expect(summary).not.toMatch(/Lifted \[|Superseded \[/);
		// A bullet keeps its id across compactions, and new ones never reuse a live id.
		const ids = [...summary.matchAll(/^- \[(C\d+)\]/gm)].map((match) => match[1]);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toHaveLength(cycle >= LIFT_AT ? cycle - 1 : cycle);

		const details = latest.details as Record<string, unknown>;
		expect(details).toMatchObject({ trigger: "user", estimatedTokensAfter: expect.any(Number) });
		expect(details.ledger).toEqual({
			constraints: ids.length,
			decisions: cycle >= SUPERSEDE_AT ? cycle - 1 : cycle,
		});
		expect(details.attemptIds).toEqual(
			sessionManager
				.getEntries()
				.filter((entry) => entry.type === "usage" && entry.kind === "compaction_attempt")
				.filter((entry) => entry.timestamp >= (details.startedAt as string))
				.map((entry) => entry.id),
		);
		if (cycle === LIFT_AT)
			expect(details.lifted).toEqual([
				{ id: "C2", text: rule(2), reason: "the user allowed touching src/file2.ts in request 4" },
			]);
		if (cycle === SUPERSEDE_AT)
			expect(details.lifted).toEqual([{ id: "D1", text: decision(1), reason: "decision 5 replaced it" }]);
		if (cycle !== LIFT_AT && cycle !== SUPERSEDE_AT) expect(details.lifted).toBeUndefined();
	}
	// From the second compaction on, the summarizer was shown the carried bullets with their ids.
	for (let cycle = 2; cycle <= CYCLES; cycle++) {
		expect(prompts[cycle]).toContain("<carried-constraints>");
		expect(prompts[cycle]).toContain(`[C1] ${rule(1)}`);
	}
	expect(prompts[LIFT_AT + 1]).not.toContain(rule(2));
});
