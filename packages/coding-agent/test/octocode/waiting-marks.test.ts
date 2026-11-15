import { animationClock, SPINNER } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { showAskDialog } from "./ask-dialog-helper.ts";
import { Breath, tabMark } from "../../src/octocode/ask/dialog/marks.ts";
import { registerAskUser } from "../../src/octocode/ask/tool.ts";
import { agentState } from "../../src/octocode/subagents/render-state.ts";
import { renderAgentCall, renderAgentMessage, renderAgentResult } from "../../src/octocode/subagents/render.ts";
import type { RunDetails } from "../../src/octocode/subagents/run-types.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

/** Colours show as tags, so a mark's colour role is visible: `<warning>◇`. */
const tagged = {
	fg: (color: string, text: string) => `<${color}>${text}`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
} as never;

const first = (component: { render(width: number): string[] }) => component.render(120)[0] ?? "";
const row = (extra: Record<string, unknown> = {}) =>
	({ args: {}, isPartial: false, isError: false, expanded: false, state: {}, ...extra }) as never;

afterEach(() => animationClock.setReducedMotion(false));

describe("waiting on you: the ask tool", () => {
	const fake = fakeHost();
	registerAskUser(fake.api);
	const tool = fake.tools.get("askUser");
	const args = { questions: [{ question: "Keep it?", header: "Export" }] };

	it("draws an open question as a still ◇ in warning when motion is reduced", () => {
		animationClock.setReducedMotion(true);
		const open = row({ isPartial: true, executionStarted: true });
		expect(first(tool.renderCall(args, tagged, open))).toMatch(/^<warning>◇ /);
	});

	it("shows answered ✓ in success, declined ✗ in error and interrupted ◼ in warning, on the header and the result", () => {
		const cases = [
			{
				details: { cancelled: false, answers: [{ question: "Keep it?", answer: "Yes", custom: false }] },
				mark: "<success>✓",
			},
			{ details: { cancelled: true, answers: [] }, mark: "<error>✗" },
			{ details: { cancelled: true, answers: [], reason: "unavailable" }, mark: "<error>✗" },
			{ details: { cancelled: true, answers: [], reason: "aborted" }, mark: "<warning>◼" },
		];
		for (const { details, mark } of cases) {
			const context = row();
			const result = tool.renderResult({ content: [], details }, {}, tagged, context);
			expect(result.render(120).join("\n")).toContain(mark);
			// The header reads the same state back from the row.
			expect(first(tool.renderCall(args, tagged, context))).toContain(mark);
		}
	});
});

describe("waiting on you: the question dialog tabs", () => {
	const questions = [
		{ question: "Which scope?", header: "Scope", options: [{ label: "Small" }, { label: "Large" }] },
		{ question: "Which extras?", header: "Extras", options: [{ label: "Docs" }] },
	];
	const tui = { requestRender: () => undefined, terminal: { rows: 40, columns: 100 } };

	it("marks an unanswered tab ◇ and an answered one ✓, and breathes only while one waits", async () => {
		animationClock.setReducedMotion(false);
		const frames: string[] = [];
		const running: boolean[] = [];
		const ctx = fakeCtx({
			cwd: process.cwd(),
			ui: {
				custom: (factory: (...args: unknown[]) => any) =>
					new Promise((resolve) => {
						const dialog = factory(tui, tagged, new KeybindingsManager(), resolve);
						frames.push(dialog.render(80).join("\n"));
						running.push(animationClock.isRunning());
						dialog.handleInput("\r"); // Scope: Small
						frames.push(dialog.render(80).join("\n"));
						dialog.handleInput("\r"); // Extras: Docs → Submit tab
						frames.push(dialog.render(80).join("\n"));
						running.push(animationClock.isRunning());
						dialog.dispose();
						resolve([]);
					}),
			},
		});
		await showAskDialog(ctx, questions);
		expect(frames[0]).toContain("<warning>◇<text> Scope");
		expect(frames[1]).toContain("<success>✓");
		expect(frames[1]).toContain("<warning>◇<text> Extras");
		expect(frames[2]).not.toContain("◇");
		expect(frames[2]).not.toMatch(/[■□]/);
		// Moving while a question waits, still once every one is answered.
		expect(running).toEqual([true, false]);
	});

	it("never subscribes in reduced motion", () => {
		animationClock.setReducedMotion(true);
		const breath = new Breath(() => undefined);
		breath.sync(true);
		expect(breath.active).toBe(false);
		expect(tabMark(tagged, false)).toBe("<warning>◇");
		expect(tabMark(tagged, true)).toBe("<success>✓");
	});
});

describe("agent rows", () => {
	const details = (extra: Partial<RunDetails> = {}): RunDetails => ({
		id: "general-0001",
		profile: "general",
		goal: "audit auth",
		toolCalls: 2,
		activity: [],
		input: 0,
		cacheRead: 0,
		output: 0,
		cost: 0,
		unpriced: false,
		startedAt: 0,
		status: "done",
		...extra,
	});
	const args = { task: "t", goal: "audit auth" };
	const content = [{ type: "text" as const, text: "Done\nAll good." }];

	it("maps each outcome to one state", () => {
		expect(agentState({ status: "running" })).toBe("running");
		expect(agentState({ status: "running", waiting: true })).toBe("waiting");
		expect(agentState({ status: "done" })).toBe("done");
		expect(agentState({ status: "done", outcome: "blocked" })).toBe("waiting");
		expect(agentState({ status: "done", outcome: "failed" })).toBe("failed");
		expect(agentState({ status: "failed" })).toBe("failed");
		expect(agentState({ status: "stopped" })).toBe("stopped");
		expect(agentState({ status: "background" })).toBe("done");
	});

	it("spins while a foreground agent works, and waits (◇) while its child asks the user", () => {
		animationClock.setReducedMotion(true);
		const call = (context: unknown) => first(renderAgentCall(args, tagged, context as never));
		const working = row({ isPartial: true, executionStarted: true });
		renderAgentResult(
			{ content, details: details({ status: "running" }) },
			{ isPartial: true } as never,
			tagged,
			working,
		);
		expect(call(working)).toContain(`<accent>${SPINNER.braille[0]}`);
		const asking = row({ isPartial: true, executionStarted: true });
		renderAgentResult(
			{ content, details: details({ status: "running", waiting: true }) },
			{ isPartial: true } as never,
			tagged,
			asking,
		);
		expect(call(asking)).toContain("<warning>◇ <toolTitle>🐙 Agent");
	});

	it.each([
		["done", {}, "<success>✓"],
		["blocked", { outcome: "blocked" as const }, "<warning>◇"],
		["failed", { outcome: "failed" as const }, "<error>✗"],
	])("draws a finished %s foreground run's header mark", (_name, extra, mark) => {
		animationClock.setReducedMotion(true);
		const context = row();
		renderAgentResult({ content, details: details(extra) }, { isPartial: false } as never, tagged, context);
		expect(first(renderAgentCall(args, tagged, context))).toContain(`${mark} <toolTitle>🐙 Agent`);
	});

	it.each([
		["done", "<success>✓"],
		["failed", "<error>✗"],
		["stopped", "<warning>◼"],
	])("draws a background report that %s with its mark", (status, mark) => {
		const message = renderAgentMessage(
			{ content: "Done", details: { id: "general-0001", status, summary: "x" } } as never,
			{ expanded: false } as never,
			tagged,
		) as unknown as { render(width: number): string[] };
		expect(message.render(120).join("\n")).toContain(`${mark} <toolTitle>🐙 Agent`);
	});
});
