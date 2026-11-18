import type { AssistantMessage } from "@octocodeai/octocode-ai";
import {
	animationClock,
	getKeybindings,
	setKeybindings,
	setPointerClicksActive as setTranscriptRowsClickable,
	type TuiMouseEvent,
} from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { resetThinkingSpans } from "../src/modes/interactive/components/reasoning-label.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { setToolInterruptShown } from "../src/core/application/interrupted-tools.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("keeps a long live reply visible and folds only after completion", () => {
		initTheme("dark");
		const text = Array.from({ length: 150 }, (_, index) => `line ${index}`).join("\n\n");
		const message = createAssistantMessage([{ type: "text", text }]);
		const component = new AssistantMessageComponent();
		component.updateContent(message, true);
		const live = stripAnsi(component.render(80).join("\n"));
		expect(live).toContain("line 75");
		expect(live).not.toContain("lines hidden");
		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("lines hidden");
		component.setExpanded(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("line 75");
		expect(message.content).toEqual([{ type: "text", text }]);
	});
	const previousKeybindings = getKeybindings();
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		resetThinkingSpans();
	});
	afterEach(() => {
		setKeybindings(previousKeybindings);
		setTranscriptRowsClickable(false);
	});

	test("ends the thinking indicator when answer text arrives and preserves reasoning", () => {
		initTheme("dark");
		const message = createAssistantMessage([{ type: "thinking", thinking: "Inspect the test results." }]);
		const component = new AssistantMessageComponent(undefined, false);
		component.updateContent(message, true);
		expect(stripAnsi(component.render(60).join("\n"))).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking…/);
		expect(stripAnsi(component.render(60).join("\n"))).not.toContain("▾ Thinking…");
		const answer = { ...message, content: [...message.content, { type: "text" as const, text: "Tests passed." }] };
		component.updateContent(answer, true);
		const rendered = stripAnsi(component.render(60).join("\n"));
		expect(rendered).toContain("▾ Thought");
		expect(rendered).not.toContain("Thinking…");
		expect(rendered).toContain("Inspect the test results.");
		expect(rendered).toContain("Tests passed.");
		component.updateContent(answer, false);
		component.setHideThinkingBlock(true);
		const hidden = stripAnsi(component.render(60).join("\n"));
		expect(hidden).toContain("▸ Thought (ctrl+t to expand)");
		expect(hidden).not.toContain("click");
		expect(hidden).not.toContain("Toggle reasoning");
	});

	describe("live reasoning label", () => {
		afterEach(() => {
			animationClock.setReducedMotion(false);
			vi.useRealTimers();
		});

		function streaming(requestRender: () => void): AssistantMessageComponent {
			initTheme("dark");
			const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking…", 1, [], {
				requestRender,
			});
			component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "Inspect it." }]), true);
			return component;
		}

		test("animates only while the block streams", () => {
			vi.useFakeTimers({ now: 1_000 });
			const requestRender = vi.fn();
			const component = streaming(requestRender);
			expect(animationClock.isRunning()).toBe(true);
			const first = component.render(60).join("\n");
			vi.advanceTimersByTime(80);
			const second = component.render(60).join("\n");
			expect(second).not.toBe(first);
			expect(stripAnsi(second)).toContain("Thinking…");
			expect(requestRender).toHaveBeenCalled();

			const answered = createAssistantMessage([
				{ type: "thinking", thinking: "Inspect it." },
				{ type: "text", text: "Done." },
			]);
			component.updateContent(answered, false);
			expect(animationClock.isRunning()).toBe(false);
			const calls = requestRender.mock.calls.length;
			vi.advanceTimersByTime(500);
			expect(requestRender.mock.calls.length).toBe(calls);
			expect(stripAnsi(component.render(60).join("\n"))).toMatch(/▾ Thought/);
		});

		test("dispose and a later non-streaming update both release the clock", () => {
			vi.useFakeTimers({ now: 1_000 });
			const component = streaming(vi.fn());
			expect(animationClock.isRunning()).toBe(true);
			component.dispose();
			expect(animationClock.isRunning()).toBe(false);
		});

		test("stops asking for frames once nothing draws the label", () => {
			vi.useFakeTimers({ now: 1_000 });
			const requestRender = vi.fn();
			streaming(requestRender);
			vi.advanceTimersByTime(2_500);
			expect(animationClock.isRunning()).toBe(false);
		});

		test("reduced motion shows the first frame and a plain label", () => {
			vi.useFakeTimers({ now: 1_000 });
			animationClock.setReducedMotion(true);
			const component = streaming(vi.fn());
			const first = component.render(60).join("\n");
			vi.advanceTimersByTime(80);
			expect(component.render(60).join("\n")).toBe(first);
			expect(stripAnsi(first)).toContain("⠋ Thinking…");
			expect(animationClock.isRunning()).toBe(false);
		});
	});

	describe("reasoning duration and hidden stub", () => {
		afterEach(() => vi.useRealTimers());

		/** Reasoning that streams for `durationMs`; the answer starts `gapMs` after its last token. */
		function streamedReasoning(durationMs: number, gapMs = 0, expanded = true): AssistantMessageComponent {
			vi.useFakeTimers({ now: 1_000 });
			const component = new AssistantMessageComponent(undefined, !expanded);
			const message = createAssistantMessage([{ type: "thinking", thinking: "First thought." }]);
			component.updateContent(message, true);
			vi.setSystemTime(1_000 + durationMs);
			const grown = createAssistantMessage([{ type: "thinking", thinking: "First thought. Second thought." }]);
			component.updateContent(grown, true);
			vi.setSystemTime(1_000 + durationMs + gapMs);
			const answered = createAssistantMessage([
				{ type: "thinking", thinking: "First thought. Second thought." },
				{ type: "text", text: "Done." },
			]);
			component.updateContent(answered, false);
			return component;
		}

		test("labels a finished block with how long the model reasoned", () => {
			initTheme("dark");
			const component = streamedReasoning(4_000);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("▾ Thought for 4s");
			component.setHideThinkingBlock(true);
			const lines = stripAnsi(component.render(80).join("\n")).split("\n");
			expect(lines.filter((line) => line.includes("Thought"))).toEqual([
				expect.stringContaining("▸ Thought for 4s (ctrl+t to expand)"),
			]);
			expect(lines.join("\n")).not.toContain("Toggle reasoning");
			expect(lines.join("\n")).not.toContain("click");
		});

		test("measures to the start of the next block, not to the last token", () => {
			initTheme("dark");
			// The thought's last token came at +2s; the answer began at +3s, which ends the reasoning.
			const component = streamedReasoning(2_000, 1_000);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("▾ Thought for 3s");
		});

		test("keeps the time when the transcript rebuilds the message's component", () => {
			initTheme("dark");
			streamedReasoning(4_000);
			// Same message id, as the application port reuses it: a fresh component first sees it complete.
			const rebuilt = new AssistantMessageComponent(
				createAssistantMessage([
					{ type: "thinking", thinking: "First thought. Second thought." },
					{ type: "text", text: "Done." },
				]),
				false,
			);
			expect(stripAnsi(rebuilt.render(80).join("\n"))).toContain("▾ Thought for 4s");
		});

		test("omits the time when unknown (a resumed block) or under a second", () => {
			initTheme("dark");
			const resumed = new AssistantMessageComponent(
				createAssistantMessage([
					{ type: "thinking", thinking: "Old thought." },
					{ type: "text", text: "Done." },
				]),
				false,
			);
			expect(stripAnsi(resumed.render(80).join("\n"))).toMatch(/▾ Thought\s*\n/);
			const brief = streamedReasoning(100);
			expect(stripAnsi(brief.render(80).join("\n"))).toMatch(/▾ Thought\s*\n/);
		});

		test("offers a click only where the terminal reports the mouse", () => {
			initTheme("dark");
			const component = streamedReasoning(4_000);
			component.setHideThinkingBlock(true);
			setTranscriptRowsClickable(true);
			component.invalidate();
			expect(stripAnsi(component.render(80).join("\n"))).toContain("▸ Thought for 4s (ctrl+t or click to expand)");
			setTranscriptRowsClickable(false);
			component.invalidate();
			expect(stripAnsi(component.render(80).join("\n"))).toContain("▸ Thought for 4s (ctrl+t to expand)");
		});

		test("collapses a finished block to one line by default and keeps an explicit false expanded", () => {
			initTheme("dark");
			const message = createAssistantMessage([
				{ type: "thinking", thinking: "Hidden reasoning." },
				{ type: "text", text: "Done." },
			]);
			const byDefault = stripAnsi(new AssistantMessageComponent(message).render(80).join("\n"));
			expect(byDefault).toContain("▸ Thought");
			expect(byDefault).not.toContain("Hidden reasoning.");
			const explicit = stripAnsi(new AssistantMessageComponent(message, false).render(80).join("\n"));
			expect(explicit).toContain("▾ Thought");
			expect(explicit).toContain("Hidden reasoning.");
		});
	});

	describe("an interrupted turn says one thing", () => {
		afterEach(() => setToolInterruptShown(false));

		const stopped = (errorMessage: string | undefined, stopReason: "aborted" | "error" = "aborted") => ({
			...createAssistantMessage([], { stopReason }),
			errorMessage,
		});

		test.each(["This operation was aborted", "Request was aborted", "Request was aborted.", undefined])(
			"maps the runtime's abort wording %s to Interrupted",
			(wording) => {
				initTheme("dark");
				const component = new AssistantMessageComponent(stopped(wording));
				const rendered = stripAnsi(component.render(60).join("\n"));
				expect(rendered).toContain("Interrupted");
				expect(rendered).not.toMatch(/aborted|Operation/);
			},
		);

		test("an abort reported as an error is still an interrupt, not an Error line", () => {
			initTheme("dark");
			const rendered = stripAnsi(
				new AssistantMessageComponent(stopped("This operation was aborted", "error")).render(60).join("\n"),
			);
			expect(rendered).toContain("Interrupted");
			expect(rendered).not.toContain("Error:");
		});

		test("keeps a specific message and real errors as they are", () => {
			initTheme("dark");
			expect(
				stripAnsi(new AssistantMessageComponent(stopped("Aborted after 2 retry attempts")).render(60).join("\n")),
			).toContain("Aborted after 2 retry attempts");
			expect(
				stripAnsi(new AssistantMessageComponent(stopped("503 overloaded", "error")).render(60).join("\n")),
			).toContain("Error: 503 overloaded");
		});

		test("says nothing when a tool row already shows the abort", () => {
			initTheme("dark");
			setToolInterruptShown(true);
			const component = new AssistantMessageComponent(stopped("This operation was aborted"));
			expect(stripAnsi(component.render(60).join("\n")).trim()).toBe("");
			// Decided once: a later run does not bring the line back to this message.
			setToolInterruptShown(false);
			component.updateContent(stopped("This operation was aborted"), false);
			expect(stripAnsi(component.render(60).join("\n")).trim()).toBe("");
		});
	});

	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders length stops with neutral truncation wording", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("Thinking stopped");
		expect(rendered).toContain("Response was truncated before completion.");
	});

	test("coalesces adjacent thinking blocks into one hidden thinking label", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.match(/Thought/g)).toHaveLength(1);
		expect(rendered).toContain("answer");
	});

	test("collapses individual thinking runs when clicked", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first reasoning" },
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "second reasoning" },
			]),
			false,
		);
		const width = 80;
		const lines = component.render(width);
		const firstThinkingRow = lines.findIndex((line) => stripAnsi(line).includes("first reasoning"));
		expect(firstThinkingRow).toBeGreaterThanOrEqual(0);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 1,
			y: firstThinkingRow,
			screenX: 1,
			screenY: firstThinkingRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(component.handleMouse(event)?.handled).toBe(true);

		const collapsed = stripAnsi(component.render(width).join("\n"));
		expect(collapsed).not.toContain("first reasoning");
		expect(collapsed).toContain("Thought");
		expect(collapsed).toContain("second reasoning");
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking…",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" hello"))).toBe(true);
		expect(lines.some((line) => line.includes(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("hello"))).toBe(true);
		expect(updatedLines.some((line) => line.startsWith("reasoning"))).toBe(true);
	});

	test("chains Markdown transformers in registration order", () => {
		initTheme("dark");
		const calls: string[] = [];
		const message = createAssistantMessage([{ type: "text", text: "The result is $x^2$." }]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking…", 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "assistant", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The result is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("identifies partial assistant Markdown as streaming", () => {
		initTheme("dark");
		const streamingStates: boolean[] = [];
		const message = createAssistantMessage([{ type: "text", text: "partial" }]);
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking…", 1, [
			(markdown, context) => {
				streamingStates.push(context.isStreaming);
				return context.isStreaming ? markdown : `${markdown} transformed`;
			},
		]);

		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("transformed");

		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("partial transformed");
		expect(streamingStates).toEqual([true, false]);
	});

	test("reapplies Markdown transformers when available width changes", () => {
		initTheme("dark");
		const availableWidths: number[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "answer" }]),
			false,
			undefined,
			"Thinking…",
			1,
			[
				(markdown, context) => {
					availableWidths.push(context.availableWidth);
					return `${markdown} (${context.availableWidth})`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("answer (78)");
		component.render(80);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("answer (58)");
		expect(availableWidths).toEqual([78, 58]);
	});

	test("continues the Markdown transformer chain when a transformer throws", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "still visible" }]),
			false,
			undefined,
			"Thinking…",
			1,
			[
				(markdown) => {
					calls.push("first");
					return markdown.replace("still", "remains");
				},
				() => {
					calls.push("throw");
					throw new Error("broken transformer");
				},
				(markdown) => {
					calls.push("last");
					return `${markdown} after error`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("remains visible after error");
		expect(calls).toEqual(["first", "throw", "last"]);
	});

	test("transforms text and thinking Markdown without mutating the original message", () => {
		initTheme("dark");
		const message = createAssistantMessage([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking…", 1, [
			(markdown, { messageType }) => {
				return `${messageType}:${markdown}`;
			},
		]);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("assistant:answer");
		expect(rendered).toContain("assistant-thinking:reasoning");
		expect(message.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
	});

	test("folds completed Markdown reversibly and leaves streaming wrapped text visible", () => {
		initTheme("dark");
		const code = Array.from({ length: 140 }, (_, i) => `const item${i} = ${i};`).join("\n");
		const hostile = "\x1b]52;c;SECRET\x07";
		const text = `Start ${hostile}\n\n\`\`\`js\n${code}\n\`\`\`\n\nEnd`;
		const component = new AssistantMessageComponent();
		const message = createAssistantMessage([{ type: "text", text }]);
		component.updateContent(message, true);
		expect(stripAnsi(component.render(60).join("\n"))).not.toContain("lines hidden");
		component.updateContent(message, false);
		const folded = component.render(60);
		expect(folded.join("\n")).not.toContain(hostile);
		expect(stripAnsi(folded.join("\n"))).toContain("lines hidden");
		expect(stripAnsi(folded.join("\n"))).toContain("item0");
		expect(stripAnsi(folded.join("\n"))).toContain("item139");
		component.setExpanded(true);
		const full = component.render(60);
		expect(full.join("\n")).not.toContain(hostile);
		expect(stripAnsi(full.join("\n"))).toContain("item70");
		expect(full.find((line) => stripAnsi(line).includes("item0"))).toBe(
			folded.find((line) => stripAnsi(line).includes("item0")),
		);
		component.setExpanded(false);
		expect(component.render(60)).toEqual(folded);
		const longLine = "abcdefghij ".repeat(400) + "LATEST";
		component.updateContent(createAssistantMessage([{ type: "text", text: longLine }]), true);
		expect(stripAnsi(component.render(20).join("\n"))).toContain("LATEST");
		component.setExpanded(true);
		expect(stripAnsi(component.render(20).join("\n"))).not.toContain("lines hidden");
		component.updateContent(createAssistantMessage([{ type: "text", text: longLine + " FINAL" }]), false);
		expect(stripAnsi(component.render(20).join("\n"))).toContain("FINAL");
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.startsWith("▎hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.startsWith("hello"))).toBe(true);
	});
});
