import { describe, expect, it } from "vitest";
import {
	applyLedger,
	carryLedger,
	LEDGER_SOFT_CAP,
	ledgerDetails,
	ledgerOf,
	ledgerPrompt,
} from "../src/core/compaction/ledger.ts";
import { TURN_CONTEXT_HEADING, withTurnContext } from "../src/core/compaction/summary-format.ts";

const previous = [
	"## Goal",
	"ship the parser",
	"",
	"## Constraints & Preferences",
	"- Never reset or switch branches in the shared checkout",
	"- No commit unless asked",
	"  (the user said so twice)",
	"",
	"## Key Decisions",
	"- **Keep the tokenizer**: the tests pin it",
	"",
	"## TL;DR",
	"Parser work.",
].join("\n");

describe("compaction ledger", () => {
	it("gives a summary written before the ledger ids in order, keeping continuation lines with their bullet", () => {
		const ledger = ledgerOf(previous);
		expect(ledger.constraints).toEqual([
			{ id: "C1", text: "Never reset or switch branches in the shared checkout" },
			{ id: "C2", text: "No commit unless asked\n  (the user said so twice)" },
		]);
		expect(ledger.decisions).toEqual([{ id: "D1", text: "**Keep the tokenizer**: the tests pin it" }]);
		expect(ledgerOf("## Constraints & Preferences\n- (none)").constraints).toEqual([]);
		expect(ledgerPrompt(ledgerOf("## Goal\nx"))).toBe("");
		expect(ledgerPrompt(ledger)).toContain("[C2] No commit unless asked");
	});

	it("puts back the carried bullets a summary left out, under a section it dropped, and drops a lift line", () => {
		const ledger = ledgerOf(previous);
		const written = [
			"## Goal",
			"ship the parser",
			"",
			"## Constraints & Preferences",
			"- never reset or switch branches in the shared checkout.",
			"- Run the suite serially",
			"",
			"## Progress",
			"- done",
			"",
			"## Where We Stopped",
			"- [D9] not a decision heading",
			"- Superseded [D1]: the tokenizer was replaced",
			"",
			"## TL;DR",
			"More parser work.",
		].join("\n");
		const { text, lifted } = applyLedger(written, ledger);
		// The same words as a carried bullet are not added twice; the carried text stays as it was.
		expect(text).toContain(
			"## Constraints & Preferences\n- [C1] Never reset or switch branches in the shared checkout\n- [C2] No commit unless asked\n  (the user said so twice)\n- [C3] Run the suite serially\n\n## Progress",
		);
		expect(text).not.toContain("never reset or switch branches in the shared checkout.");
		// A lift written outside the ledger sections is not seen: the decision stays, and the summary keeps that line.
		expect(text).toContain("## Key Decisions\n- [D1] **Keep the tokenizer**: the tests pin it\n\n## Where We Stopped");
		expect(lifted).toEqual([]);
	});

	it("lifts a carried bullet only when the model names its id, and never reuses a live id", () => {
		const ledger = ledgerOf(applyLedger(previous, { constraints: [], decisions: [] }).text);
		const { text, lifted } = applyLedger(
			[
				"## Constraints & Preferences",
				"- Lifted [C2]: the user now commits after each step",
				"- [C1] Never reset branches (reworded)",
				"- Lifted [C7]: no such rule",
				"",
				"## Key Decisions",
				"- Superseded [D1] - a rewrite replaced it",
				"- **Use the new lexer**: faster",
			].join("\n"),
			ledger,
		);
		expect(lifted).toEqual([
			{
				id: "C2",
				text: "No commit unless asked\n  (the user said so twice)",
				reason: "the user now commits after each step",
			},
			{ id: "D1", text: "**Keep the tokenizer**: the tests pin it", reason: "a rewrite replaced it" },
		]);
		expect(text).toBe(
			[
				"## Constraints & Preferences",
				"- [C1] Never reset or switch branches in the shared checkout",
				"",
				"## Key Decisions",
				"- [D2] **Use the new lexer**: faster",
			].join("\n"),
		);
	});
});

describe("compaction ledger restatements", () => {
	const carried = ledgerOf(
		[
			"## Constraints & Preferences",
			"- [C1] Never reset or switch branches in the shared checkout",
			"- [C2] No commit unless the user asks",
			"- [C3] Budget: up to $25 for subagents",
			"- [C4] Commit after each finished step",
			"",
			"## Key Decisions",
			"- [D1] **Keep the tokenizer**: the tests pin it",
		].join("\n"),
	);
	const constraints = (text: string) => ledgerOf(text).constraints.map((bullet) => `${bullet.id} ${bullet.text}`);

	it("keeps the carried words when the model restates a rule in its own words without the id", () => {
		const { text } = applyLedger(
			[
				"## Constraints & Preferences",
				"- In the shared checkout, never switch or reset branches.",
				"- Do not commit unless the user asks.",
				"",
				"## Key Decisions",
				"- **Keep the tokenizer:** the tests pin it down",
			].join("\n"),
			carried,
		);
		expect(constraints(text)).toEqual([
			"C1 Never reset or switch branches in the shared checkout",
			"C2 No commit unless the user asks",
			"C3 Budget: up to $25 for subagents",
			"C4 Commit after each finished step",
		]);
		expect(ledgerOf(text).decisions).toEqual([{ id: "D1", text: "**Keep the tokenizer**: the tests pin it" }]);
	});

	it("adds a bullet that says more, turns a rule around or changes a number", () => {
		const { text } = applyLedger(
			[
				"## Constraints & Preferences",
				// Restates C1 and adds a rule of its own: dropping it would lose the new rule.
				"- Never reset or switch branches in the shared checkout; run the suites one at a time and never in parallel",
				// The words of C4 with the opposite meaning.
				"- Do not commit after each finished step",
				"- Budget: up to $40 for subagents",
				"- Never touch src/file2.ts without asking",
				"- Never touch src/file1.ts without asking",
			].join("\n"),
			carried,
		);
		expect(constraints(text).slice(4)).toEqual([
			"C5 Never reset or switch branches in the shared checkout; run the suites one at a time and never in parallel",
			"C6 Do not commit after each finished step",
			"C7 Budget: up to $40 for subagents",
			"C8 Never touch src/file2.ts without asking",
			"C9 Never touch src/file1.ts without asking",
		]);
	});

	it("collapses restatements within one summary, and adds a lifted rule's new version", () => {
		const { text, lifted } = applyLedger(
			[
				"## Constraints & Preferences",
				"- Lifted [C2]: the user now wants a commit per item",
				"- Commit once per finished backlog item",
				"- Commit once for each finished backlog item.",
				"- No commit unless the user asks",
				"- Run the suites serially",
				"- run the suites serially",
			].join("\n"),
			carried,
		);
		expect(lifted.map((bullet) => bullet.id)).toEqual(["C2"]);
		// The lifted rule's exact words come back as a new bullet: the model wrote them again.
		expect(constraints(text).slice(3)).toEqual([
			"C5 Commit once per finished backlog item",
			"C6 No commit unless the user asks",
			"C7 Run the suites serially",
		]);
	});

	it("reads only the lift forms the request names, not a restated rule that starts with the word", () => {
		const ledger = ledgerOf("## Constraints & Preferences\n- [C1] Withdrawn flags stay hidden\n- [C2] No commit");
		const restated = applyLedger(
			"## Constraints & Preferences\n- [C1] Withdrawn flags stay hidden\n- **Lifted [C2]**: the user commits now",
			ledger,
		);
		expect(restated.lifted).toEqual([{ id: "C2", text: "No commit", reason: "the user commits now" }]);
		expect(constraints(restated.text)).toEqual(["C1 Withdrawn flags stay hidden"]);
		expect(applyLedger("## Constraints & Preferences\n- [C1] lifted: done", ledger).lifted[0]?.id).toBe("C1");
	});

	it("asks for consolidation past the soft cap, drops nothing, and counts the bullets in the details", () => {
		const many = Array.from({ length: LEDGER_SOFT_CAP + 1 }, (_, at) => `- Rule ${at} about module m${at}`);
		const previous = carryLedger(`## Constraints & Preferences\n${many.join("\n")}`, undefined).text;
		const ledger = ledgerOf(previous);
		expect(ledger.constraints).toHaveLength(LEDGER_SOFT_CAP + 1);
		expect(ledgerPrompt(ledger)).toMatch(/consolidate/);
		expect(ledgerPrompt(ledgerOf("## Constraints & Preferences\n- one rule"))).not.toMatch(/consolidate/);
		const next = carryLedger("## Constraints & Preferences\n- A new rule about logging", previous);
		expect(ledgerOf(next.text).constraints).toHaveLength(LEDGER_SOFT_CAP + 2);
		expect(ledgerDetails(next.text, next.lifted)).toEqual({
			ledger: { constraints: LEDGER_SOFT_CAP + 2, decisions: 0 },
		});
		expect(ledgerDetails("## Goal\nx", [])).toEqual({});
	});
});

describe("split turn context", () => {
	it("is a section of the checkpoint ahead of its closing TL;DR", () => {
		const merged = withTurnContext("## Goal\nx\n\n## TL;DR\ndone\nTopics: a, b, c", "### Original Request\n- y\n");
		expect(merged).toBe(
			`## Goal\nx\n\n${TURN_CONTEXT_HEADING}\n\n### Original Request\n- y\n\n## TL;DR\ndone\nTopics: a, b, c`,
		);
		expect(withTurnContext("No prior history.", "### Original Request\n- y")).toBe(
			`No prior history.\n\n${TURN_CONTEXT_HEADING}\n\n### Original Request\n- y`,
		);
	});
});
