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
			expect(text).toContain("a child costs a fresh context, your brief and your check of its report");
			expect(text).toContain("start one only when parallel parts or a clean context save more than that");
		}
	});

	it("plans work for two or more children as one backlog graph: owner, files, check and real dependencies per item", () => {
		for (const text of delegation()) {
			const plan = text.split("\n").find((line) => line.startsWith("  1. First plan the work as a graph")) ?? "";
			expect(plan).toContain("one `backlogPlan` `add`");
			expect(plan).toContain("its owner (you or one child), its files, its pass/fail check and only real `dependsOn`");
			// Reservations and busy children are scheduling, not dependencies.
			expect(plan).toContain("a file a child reserves, or a busy child, is not one");
			// The user sees who does what before work starts.
			expect(plan).toContain("show the user the plan as a table: item, owner, depends on");
		}
	});

	it("checks the graph before starting: disjoint files, one owner per coupling and resource, work worth a start, critical path first", () => {
		for (const text of delegation()) {
			const check = text.split("\n").find((line) => line.startsWith("  2. Check the graph before you start it")) ?? "";
			expect(check).toContain("give coupled work one owner and independent work disjoint files");
			expect(check).toContain("each shared resource (such as a build) one owner");
			expect(check).toContain("merge parts too small to pay for a child, or do them yourself");
			expect(check).toContain("start the longest dependency chain first");
		}
	});

	it("runs the graph in waves with one build, and sends a failure back to the item that caused it", () => {
		for (const text of delegation()) {
			const waves = text.split("\n").find((line) => line.startsWith("  3. Run the graph in waves")) ?? "";
			expect(waves).toContain("interfaces and shared types first");
			expect(waves).toContain("then every item whose files and dependencies are free, together");
			expect(waves).toContain("one build and full test run by its owner");
			// Build cycles: children never run whole builds, and a broken build is not a new child.
			expect(waves).toContain("children run only the focused tests of their own files");
			expect(waves).toContain(
				"a failing build or test goes back to the child that owns the item (continue it as below), not to a new child",
			);
			expect(waves).toContain("review the combined diff");
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
			for (const rule of [
				"plan the work as a graph",
				"Check the graph before you start it",
				"Run the graph in waves",
			]) {
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
		const plan = text.split("\n").find((line) => line.startsWith("  1. First plan the work as a graph")) ?? "";
		expect(plan).toContain("plan the work as a graph: one part per piece");
		expect(plan).toContain("show the user the plan as a table: part, owner, depends on");
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
