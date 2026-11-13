import { describe, expect, it } from "vitest";
import { octocodePromptSections } from "../../src/octocode/instructions/policy.ts";
import { FAKE_RESEARCH } from "./fake-research.ts";

/**
 * The coordinator's planning contract: work across several children is planned as a graph in the backlog, the graph is
 * checked before anything starts, it runs in waves with one build, and a child is started only when it saves more than
 * it costs. These are the rules the coordinator reads; the backlog and agent tools own their mechanics.
 */
function delegation(): string[] {
	return [FAKE_RESEARCH, undefined].map(
		(research) => octocodePromptSections({ research, profiles: [], canDelegate: true }).delegation ?? "",
	);
}

describe("coordinator planning graph", () => {
	it("weighs a child's cost before starting one, and keeps doing the work itself as the default", () => {
		for (const text of delegation()) {
			expect(text).toContain("Do the work yourself by default");
			// The cost a coordinator under-counts: a fresh context, its own brief and checking the report.
			expect(text).toContain("children cost context, briefing and verification");
			expect(text).toContain("know only their brief and return summaries that may be wrong");
			expect(text).toContain("Delegate only when parallel parts or a clean context repay that cost");
		}
	});

	it("plans work for two or more children as one backlog graph: owner, files, check and real dependencies per item", () => {
		for (const text of delegation()) {
			const plan = text.split("\n").find((line) => line.startsWith("  1. Plan a graph")) ?? "";
			expect(plan).toContain("one `backlogPlan` `add`");
			expect(plan).toContain("its owner (you or one child), files, pass/fail check and only real `dependsOn`");
			// Reservations and busy children are scheduling, not dependencies.
			expect(plan).toContain("Reservations and busy children are not dependencies");
			// The user sees who does what before work starts.
			expect(plan).toContain("Show the user a table: item, owner, depends on");
		}
	});

	it("checks the graph before starting: disjoint files, one owner per coupling and resource, work worth a start, critical path first", () => {
		for (const text of delegation()) {
			const check = text.split("\n").find((line) => line.startsWith("  2. Check the graph before starting")) ?? "";
			expect(check).toContain("one owner per coupled part or shared resource");
			expect(check).toContain("shared resource (including builds)");
			expect(check).toContain("disjoint files for independent parts");
			expect(check).toContain("Merge parts too small to justify a child or do them yourself");
			expect(check).toContain("start the longest dependency chain first");
		}
	});

	it("runs the graph in waves with one build, and sends a failure back to the item that caused it", () => {
		for (const text of delegation()) {
			const waves = text.split("\n").find((line) => line.startsWith("  3. Run waves")) ?? "";
			expect(waves).toContain("interfaces and shared types first");
			expect(waves).toContain("then all parts with free files and satisfied dependencies");
			expect(waves).toContain("one owner runs one build and the full test run");
			// Build cycles: children never run whole builds, and a broken build is not a new child.
			expect(waves).toContain("children run only focused tests of their files");
			expect(waves).toContain("Return failing builds or tests to the owning child as below, not a new child");
			expect(waves).toContain("Review the combined diff");
		}
	});

	it("gives the coordination graph to the main session only: a subagent never plans, checks or runs one", () => {
		for (const research of [FAKE_RESEARCH, undefined]) {
			const sections = octocodePromptSections({ research, profiles: [], canDelegate: false });
			const child = Object.values(sections).join("\n");
			// A child's own section holds the subagent policy: it finishes its own task and starts no agents. The
			// `delegation` name stays the coordinator's, so a child never reads a `<delegation>` tag it cannot act on.
			expect(sections.coordinator).toContain("You are a subagent: finish your task yourself.");
			expect(sections.delegation).toBe("");
			expect(octocodePromptSections({ research, profiles: [], canDelegate: true }).coordinator).toBe("");
			for (const rule of ["Plan a graph", "Check the graph before starting", "Run waves"]) {
				expect(child).not.toContain(rule);
			}
		}
	});

	it("puts the coordinator's own work in the graph, not only its children's", () => {
		for (const text of delegation()) expect(text).toContain("its owner (you or one child)");
	});

	it("plans the graph without the backlog when the session runs without the backlog tool", () => {
		// The delegation section and, once a child started, the `children` section: neither may name the backlog.
		const sections = octocodePromptSections({
			research: FAKE_RESEARCH,
			profiles: [],
			canDelegate: true,
			canBacklog: false,
			childStarted: true,
		});
		const text = `${sections.delegation}\n${sections.children}`;
		const plan = text.split("\n").find((line) => line.startsWith("  1. Plan a graph")) ?? "";
		expect(plan).toContain("Plan a graph: one part per independently checkable result");
		expect(plan).toContain("Show the user a table: part, owner, depends on");
		// No rule may send the coordinator to a tool it lacks.
		expect(text).not.toContain("backlog");
		expect(text).not.toContain("`dependsOn`");
		expect(text).not.toContain("`until item`");
		expect(text).toContain("Read `coordinate` `list` for status");
	});

	it("states each planning rule once", () => {
		for (const text of delegation()) {
			expect(text.match(/disjoint files/g) ?? []).toHaveLength(1);
			expect(text.match(/landing order/g) ?? []).toHaveLength(1);
			expect(text.match(/`dependsOn`/g) ?? []).toHaveLength(1);
			expect(text.match(/combined diff/g) ?? []).toHaveLength(1);
		}
	});
});
