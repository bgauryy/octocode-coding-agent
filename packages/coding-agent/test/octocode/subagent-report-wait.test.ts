import { describe, expect, it } from "vitest";
import { newChildState, reduceEvent } from "../../src/octocode/subagents/events.ts";
import { ReportTracker } from "../../src/octocode/subagents/report.ts";

/** A child that ends a turn with a background job or timer pending says it waits; that text is not its report. */
describe("the final text of a child that waits on its own work", () => {
	const LIMITS = { idleMs: 1_000, busyMs: 5_000 };
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
	const reply = (text: string, stopReason = "stop") => ({
		type: "message_end",
		message: { role: "assistant", stopReason, content: [{ type: "text", text }], usage },
	});
	const start = (toolName: string, args: Record<string, unknown>) => ({ type: "tool_execution_start", toolName, args });
	const userTurn = { type: "message_end", message: { role: "user", content: "go" } };
	const JOB = "Background bash job-1 finished (exit 0)";

	function run(events: Array<Record<string, unknown>>) {
		const state = newChildState();
		const report = new ReportTracker();
		for (const event of events)
			for (const effect of reduceEvent(state, event, LIMITS, 1_000))
				if (effect.kind === "answer")
					report.answer(effect.text, effect.stopReason, effect.errorMessage, effect.waiting, effect.reminder);
				else if (effect.kind === "incoming") report.incoming(effect.role, effect.job, effect.quiet);
		return { state, report };
	}
	const job = start("bash", { background: true, command: "yarn test" });

	const PHRASES = [
		"I'll wait for the background run",
		"The checks are running in the background; I'll report once they finish.",
		"Waiting for load to drop under 15.",
	];

	describe.each(PHRASES)("%s", (phrase) => {
		it("is no report on the first turn, and the report that follows is the only one", () => {
			const { report, state } = run([userTurn, job, reply(phrase)]);
			expect(state.waits).toBe(1);
			expect(report.holdsWait).toBe(true);
			expect(report.lacksOutcome).toBe(false);
			report.incoming("custom", JOB, true);
			expect(report.holdsWait).toBe(true);
			report.incoming("custom", JOB);
			report.answer("done: the suite passes.", "stop");
			const result = report.result();
			expect(result.text).toBe("done: the suite passes.");
			expect(result).toMatchObject({ outcome: "done", answered: true });
		});

		it("is still the last word when the run ends with the job pending", () => {
			const { report } = run([userTurn, job, reply(phrase)]);
			expect(report.result()).toMatchObject({ text: phrase, answered: true });
			// Asking again changes nothing: the text is released once.
			expect(report.result().text).toBe(phrase);
		});

		it("is delivered with the failure when the child's next turn fails", () => {
			const { report } = run([userTurn, job, reply(phrase)]);
			report.answer(undefined, "error", "provider down", true);
			const result = report.result();
			expect(result.text).toContain(phrase);
			expect(result.error).toContain("provider down");
		});

		it("is a report when no work is pending", () => {
			const { report } = run([userTurn, reply(phrase)]);
			expect(report.holdsWait).toBe(false);
			expect(report.result().text).toBe(phrase);
		});

		it("is replaced by the next final answer, and leaves the earlier report alone", () => {
			const { report } = run([userTurn, reply("done: first."), job, userTurn, reply(phrase), reply("done: second.")]);
			expect(report.holdsWait).toBe(false);
			expect(report.result().text).not.toContain(phrase);
		});
	});

	it("after a report already given, a plain waiting line adds nothing and other text is kept when the run ends", () => {
		const given = [userTurn, reply("done: first."), job, userTurn];
		expect(run([...given, reply("Waiting for load to drop under 15.")]).report.result().text).toBe("done: first.");
		const more = run([...given, reply("Load is high.\nThe build log shows a failure in x.ts.")]);
		expect(more.report.result().text).toContain("a failure in x.ts");
	});

	it("delivers a text that names an outcome while the job is pending", () => {
		for (const text of ["blocked: the runner needs a credential.", "done: nothing left to run."]) {
			const { report } = run([userTurn, job, reply(text)]);
			expect(report.holdsWait).toBe(false);
			expect(report.hasReport).toBe(true);
			expect(report.result().text).toBe(text);
		}
	});

	it("still delivers a failed turn while the job is pending", () => {
		for (const stopReason of ["error", "aborted", "length"]) {
			const { report } = run([userTurn, job, reply("partial notes", stopReason)]);
			expect(report.result().error).toBeTruthy();
		}
	});

	it("holds a wait that follows a tool turn, and the last of several wait texts wins", () => {
		const { report } = run([
			userTurn,
			job,
			reply("I'll wait."),
			reply("Still on it.", "toolUse"),
			reply("Waiting for load."),
		]);
		expect(report.holdsWait).toBe(true);
		expect(report.result().text).toBe("Waiting for load.");
	});
});
