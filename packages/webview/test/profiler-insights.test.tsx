/** @vitest-environment jsdom */
import type { ProfileFinding } from "@octocodeai/octocode-contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupFindings, orderFindings, summarizeFindings } from "../src/app/live/profiler/insight-model.ts";
import { InsightsPanel } from "../src/app/live/profiler/InsightsPanel.tsx";

afterEach(cleanup);

function finding(id: string, patch: Partial<ProfileFinding> = {}): ProfileFinding {
	return {
		id,
		kind: "cache-rewrite",
		severity: "low",
		title: `Finding ${id}`,
		detail: `Cause ${id}`,
		evidence: [],
		...patch,
	};
}

const mixed = [
	finding("a", { severity: "low", kind: "slow-tool" }),
	finding("b", {
		severity: "high",
		cost: 0.31,
		tokens: 81_000,
		agentId: "main",
		evidence: [
			{ agentId: "main", request: 2 },
			{ agentId: "main", event: "main:tool:t0" },
		],
	}),
	finding("c", { severity: "medium", kind: "permission-wait", waitedMs: 252_000, cost: 0.5 }),
	finding("d", { severity: "high", kind: "dead-letter" }),
];

describe("insight model", () => {
	it("puts high before medium before low and keeps the host's order within a severity", () => {
		expect(orderFindings(mixed).map((f) => f.id)).toEqual(["b", "d", "c", "a"]);
	});

	it("summarises issues, avoidable cost, waiting and the checks that passed", () => {
		const summary = summarizeFindings(mixed);
		expect(summary).toMatchObject({ issues: 4, waitedMs: 252_000, checks: 11 });
		expect(summary.cost).toBeCloseTo(0.81);
		expect(summary.passed).not.toContain("slow-tool");
		expect(summary.passed).toHaveLength(7);
		expect(summarizeFindings([]).passed).toHaveLength(11);
	});

	it("folds a kind with more than five findings into one group at its first place", () => {
		const many = Array.from({ length: 6 }, (_, i) => finding(`r${i}`, { severity: "high" }));
		const entries = groupFindings(orderFindings([finding("x", { severity: "high", kind: "slow-tool" }), ...many]));
		expect(entries.map((e) => e.type)).toEqual(["finding", "group"]);
		expect(entries[1]).toMatchObject({ type: "group", kind: "cache-rewrite" });
		expect(groupFindings(many.slice(0, 5)).every((e) => e.type === "finding")).toBe(true);
	});
});

describe("InsightsPanel", () => {
	it("leads with the summary line and the worst finding, and folds the passed checks", () => {
		render(createElement(InsightsPanel, { findings: mixed, onSelect: vi.fn() }));
		expect(screen.getByText("4 issues \u00B7 $0.81 avoidable \u00B7 4m waited \u00B7 7 checks passed")).toBeTruthy();
		const items = within(screen.getByRole("list", { name: "Findings, most costly first" })).getAllByRole("listitem");
		expect(items[0]?.textContent).toContain("Finding b");
		expect(items[0]?.textContent).toContain("$0.31");
		expect(items[0]?.textContent).toContain("main");
		expect(items.at(-1)?.textContent).toContain("Finding a");
		expect(screen.getByRole("list", { name: "Checks that passed" })).toBeTruthy();
	});

	it("opens the first evidence on click and any evidence from its button, telling the Trace which finding", () => {
		const onSelect = vi.fn();
		const onEvidence = vi.fn();
		render(createElement(InsightsPanel, { findings: mixed, onSelect, onEvidence }));
		fireEvent.click(screen.getByRole("button", { name: /Finding b/ }));
		expect(onSelect).toHaveBeenLastCalledWith({ kind: "request", agentId: "main", index: 2 });
		expect(onEvidence).toHaveBeenLastCalledWith(mixed[1]);
		fireEvent.click(screen.getByRole("button", { name: "main:tool:t0" }));
		expect(onSelect).toHaveBeenLastCalledWith({ kind: "event", id: "main:tool:t0" });
	});

	it("groups a repeated kind with its count", () => {
		const many = Array.from({ length: 6 }, (_, i) => finding(`r${i}`));
		render(createElement(InsightsPanel, { findings: many, onSelect: vi.fn() }));
		expect(screen.getByText(/Cached prefix rewritten/).textContent).toContain("6");
	});

	it("says no issues were found and lists every check that ran", () => {
		render(createElement(InsightsPanel, { findings: [], onSelect: vi.fn() }));
		expect(screen.getByText(/No issues found/).textContent).toContain("11 checks passed");
		expect(within(screen.getByRole("list", { name: "Checks that passed" })).getAllByRole("listitem")).toHaveLength(11);
		expect(screen.queryByRole("list", { name: "Findings, most costly first" })).toBeNull();
	});

	it("shows a loading note until the findings arrive", () => {
		render(createElement(InsightsPanel, { findings: undefined, onSelect: vi.fn() }));
		expect(screen.getByText(/Loading insights/)).toBeTruthy();
	});
});
