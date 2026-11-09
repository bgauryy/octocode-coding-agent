import { afterEach, describe, expect, it } from "vitest";
import { fenceUntrusted } from "../../src/octocode/shared/fence.ts";
import { setItemTitles, withItemTitlesIn } from "../../src/octocode/render/item-titles.ts";
import { renderAgentMessage, renderAgentResult } from "../../src/octocode/subagents/render.ts";
import type { RunDetails } from "../../src/octocode/subagents/run-types.ts";
import { rendered, theme } from "./fake-host.ts";

afterEach(() => setItemTitles(new Map()));

const details = { id: "general-0001", goal: "audit", status: "done", input: 0, output: 0, cacheRead: 0 } as RunDetails;
const content = fenceUntrusted("Subagent general-0001 finished", "Child says B12 is fine", {
	footer: "Noted on B12.",
});
const ctx = { args: {}, isPartial: false, isError: false, expanded: true, state: {} } as never;

describe("titles in subagent report rows", () => {
	it("decorates the host footer of a foreground result but never the child's report", () => {
		setItemTitles(new Map([["B12", "Report notices"]]));
		const text = rendered(
			renderAgentResult(
				{ content: [{ type: "text", text: content }], details },
				{ isPartial: false, expanded: true },
				theme,
				ctx,
			),
		);
		expect(text).toContain("Noted on B12 “Report notices”.");
		expect(text).toContain("Child says B12 is fine");
	});

	it("does the same for a background report message", () => {
		setItemTitles(new Map([["B12", "Report notices"]]));
		const text = rendered(
			renderAgentMessage(
				{ customType: "agent-result", content: [{ type: "text", text: content }], details } as never,
				{ expanded: true, outputPad: 1 },
				theme,
			)!,
		);
		expect(text).toContain("Noted on B12 “Report notices”.");
		expect(text).toContain("Child says B12 is fine");
	});

	it("leaves an unknown ID in the footer as written", () => {
		const text = rendered(
			renderAgentResult(
				{ content: [{ type: "text", text: content }], details },
				{ isPartial: false, expanded: true },
				theme,
				ctx,
			),
		);
		expect(text).toContain("Noted on B12.");
	});

	it("withItemTitlesIn decorates only the last occurrence of the part", () => {
		const titleOf = (ref: string) => (ref === "B1" ? "One" : undefined);
		expect(withItemTitlesIn("B1 body\n\nNoted on B1.", "Noted on B1.", titleOf)).toBe("B1 body\n\nNoted on B1 “One”.");
		expect(withItemTitlesIn("B1 body", "", titleOf)).toBe("B1 body");
		expect(withItemTitlesIn("B1 body", "absent", titleOf)).toBe("B1 body");
	});
});
