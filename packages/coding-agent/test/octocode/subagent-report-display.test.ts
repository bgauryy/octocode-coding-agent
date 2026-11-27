import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { describe, expect, it } from "vitest";
import { displayReport, withoutOutcome } from "../../src/octocode/subagents/report-display.ts";
import { renderAgentCall, renderAgentMessage } from "../../src/octocode/subagents/render.ts";
import { fenceUntrusted } from "../../src/octocode/shared/fence.ts";
import { rendered, theme } from "./fake-host.ts";

const SEP = "\n\n---\n\n";

describe("withoutOutcome", () => {
	it("drops a leading outcome word or label, for the screen only", () => {
		expect(withoutOutcome("done\n- name: x")).toBe("- name: x");
		expect(withoutOutcome("done")).toBe("");
		expect(withoutOutcome("partial: I sent the question")).toBe("I sent the question");
		expect(withoutOutcome("**Blocked**: need a decision")).toBe("need a decision");
		expect(withoutOutcome("Report: done. Found it")).toBe("Found it");
		expect(withoutOutcome("a\nb\noutcome: done")).toBe("a\nb");
	});

	it("keeps text that is not a bare outcome word", () => {
		expect(withoutOutcome("Done with the audit")).toBe("Done with the audit");
		expect(withoutOutcome("**Done: all good**")).toBe("**Done: all good**");
		expect(withoutOutcome("No outcome here")).toBe("No outcome here");
	});
});

describe("displayReport", () => {
	const stacked = `partial: asked a question${SEP}Follow-up to the report above (job done):\ndone: the answer was red`;

	it("shows only the latest report collapsed and counts the earlier ones", () => {
		expect(displayReport(stacked, false)).toEqual({ text: "the answer was red", earlier: 1 });
	});

	it("shows every report expanded, each without its outcome word", () => {
		expect(displayReport(stacked, true)).toEqual({
			text: `asked a question${SEP}Follow-up to the report above (job done):\nthe answer was red`,
			earlier: 0,
		});
	});

	it("does not split a report that holds a Markdown rule", () => {
		const text = `done: first part${SEP}second part, no outcome`;
		expect(displayReport(text, false)).toEqual({ text: `first part${SEP}second part, no outcome`, earlier: 0 });
	});

	it("keeps a failed later turn with the latest report", () => {
		const text = `done: one${SEP}done: two${SEP}(A later follow-up turn failed: boom)`;
		expect(displayReport(text, false)).toEqual({ text: `two${SEP}(A later follow-up turn failed: boom)`, earlier: 1 });
	});
});

describe("background report rows", () => {
	const message = (content: string, expanded = false, extra: Record<string, unknown> = {}) =>
		rendered(
			renderAgentMessage(
				{
					role: "custom",
					customType: "x",
					content,
					display: true,
					timestamp: 0,
					details: {
						id: "sleepy-otter",
						status: "done",
						outcome: "done",
						summary: "Done · 2 tool calls · 15s",
						durationMs: 15_000,
						...extra,
					},
				} as never,
				{ expanded, outputPad: 1 },
				theme,
			) as never,
		);
	const report = (body: string) => fenceUntrusted("Background subagent sleepy-otter reported done", body);

	it("does not repeat the outcome word under the summary", () => {
		const text = message(report("done\n- name: pkg"));
		expect(text).toContain("⎿  Done · 2 tool calls · 15s");
		expect(text).toContain("- name: pkg");
		expect(text).not.toMatch(/\n\s+done\n/);
		expect(text).not.toContain("sleepy-otter · 2 tool calls");
	});

	it("folds earlier reports into one line collapsed and shows them all expanded", () => {
		const body = `partial: asked${SEP}done: answered red`;
		expect(message(report(body))).toMatch(/\+1 earlier report \(\S+ to expand\)\n\s+answered red/);
		expect(message(report(body))).not.toContain("asked");
		const open = message(report(body), true);
		expect(open).toContain("asked");
		expect(open).toContain("answered red");
		expect(open).not.toContain("earlier report");
	});

	it("draws the whole saved report, collapsed too, where the message content holds only the head", () => {
		const full = `done\n${Array.from({ length: 80 }, (_, i) => `finding ${i}`).join("\n")}\nthe last finding`;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-full-"));
		const hash = sha256(full);
		const file = path.join(dir, `report-${hash}.md`);
		fs.writeFileSync(file, full);
		const reportArtifact = { path: file, sha256: hash };
		const shown = message(report("done\nfinding 0\n… cut"), false, { reportArtifact });
		expect(shown).toContain("finding 79");
		expect(shown).toContain("the last finding");
		expect(shown).not.toMatch(/\+\d+ lines/);
		// A saved version that no longer matches its hash is not trusted: the content is drawn.
		fs.writeFileSync(file, "tampered");
		expect(message(report("done\nfinding 0\n… cut"), false, { reportArtifact })).not.toContain("tampered");
		fs.rmSync(dir, { recursive: true });
	});

	it("shows tokens, cost and the model without provider only when expanded", () => {
		const extra = {
			usage: { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
			model: "anthropic/claude-haiku-5-5",
		};
		expect(message(report("done\nx"), false, extra)).not.toContain("claude-haiku");
		const open = message(report("done\nx"), true, extra);
		expect(open).toContain("Done · 2 tool calls · 15s · ↑1k ↓200 · ≈$0.50 · claude-haiku-5-5");
		expect(open).not.toContain("anthropic/");
	});
});

describe("background launch row", () => {
	const call = (durationMs: number | undefined) =>
		rendered(
			renderAgentCall({ goal: "g", background: true }, theme, {
				args: {},
				lastComponent: undefined,
				isPartial: false,
				isError: false,
				expanded: false,
				state: {},
				...(durationMs !== undefined ? { durationMs } : {}),
			}),
		);

	it("shows no millisecond launch time, but a slow launch keeps its time", () => {
		expect(call(68)).toMatch(/Agent\(g\) · background$/m);
		expect(call(2_400)).toMatch(/background · 2\.4s/);
	});
});
