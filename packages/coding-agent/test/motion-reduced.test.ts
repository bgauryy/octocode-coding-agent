import { animationClock, rgbColor, styleText, type TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountdownTimer } from "../src/modes/interactive/components/countdown-timer.ts";
import { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme } from "../src/theme/theme.ts";
import { bannerHeader } from "../src/octocode/ui/chrome.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/** A theme with concrete colours, so the banner has a gradient ramp. */
const colorTheme = {
	fg: (_color: string, text: string) => text,
	appearance: "dark",
	colors: {
		accent: rgbColor(192, 132, 252),
		borderAccent: rgbColor(167, 139, 250),
		mdLink: rgbColor(165, 180, 252),
		syntaxOperator: rgbColor(94, 234, 212),
		dim: rgbColor(139, 148, 158),
		text: rgbColor(230, 237, 243),
	},
	style: (text: string, options: Parameters<typeof styleText>[1]) => styleText(text, options, "truecolor"),
} as never;

/** Advance fake time in steps no longer than the spinner frame, as the real event loop would. */
function advance(ms: number, step = 80): void {
	for (let elapsed = 0; elapsed < ms; elapsed += step) vi.advanceTimersByTime(Math.min(step, ms - elapsed));
}

const fakeTui = () =>
	({ requestRender: vi.fn(), terminal: { rows: 10 } }) as unknown as TUI & { requestRender: ReturnType<typeof vi.fn> };

describe("paint timers on the animation clock", () => {
	beforeEach(() => {
		initTheme("octocode-dark");
		vi.useFakeTimers({ now: 1_000_000 });
	});
	afterEach(() => {
		animationClock.setReducedMotion(false);
		vi.useRealTimers();
	});

	it("runs no timer once the working indicator is disposed", () => {
		const indicator = new WorkingStatusIndicator(fakeTui(), "Thinking");
		expect(animationClock.isRunning()).toBe(true);
		indicator.dispose();
		expect(animationClock.isRunning()).toBe(false);
	});

	it("freezes the spinner and shimmer in reduced motion while the elapsed time still advances", () => {
		const tui = fakeTui();
		const indicator = new WorkingStatusIndicator(tui, "Writing the summary");
		const line = () => indicator.render(80)[1];
		advance(240);
		const animated = [line()];
		advance(400);
		expect(line()).not.toBe(animated[0]);

		animationClock.setReducedMotion(true);
		const frozen = line();
		tui.requestRender.mockClear();
		advance(800);
		// Same spinner frame and plain detail: nothing moved yet (the clock text is still 1s granular).
		expect(stripAnsi(line())).toBe(stripAnsi(frozen));
		advance(1_600);
		expect(stripAnsi(line())).not.toBe(stripAnsi(frozen));
		expect(stripAnsi(line()).replace(/\(.*\)/, "")).toBe(stripAnsi(frozen).replace(/\(.*\)/, ""));
		// Elapsed text repaints about once a second; the 80 ms spinner repaints are gone.
		expect(tui.requestRender.mock.calls.length).toBeLessThanOrEqual(3);
		expect(tui.requestRender.mock.calls.length).toBeGreaterThanOrEqual(2);
		indicator.dispose();
	});

	it("stops the countdown on dispose and on expiry, and keeps counting in reduced motion", () => {
		animationClock.setReducedMotion(true);
		const ticks: number[] = [];
		const expired = vi.fn();
		const countdown = new CountdownTimer(3_000, fakeTui(), (seconds) => ticks.push(seconds), expired);
		advance(3_100);
		expect(ticks).toEqual([3, 2, 1, 0]);
		expect(expired).toHaveBeenCalledOnce();
		expect(animationClock.isRunning()).toBe(false);

		const second = new CountdownTimer(5_000, fakeTui(), () => {}, expired);
		expect(animationClock.isRunning()).toBe(true);
		second.dispose();
		countdown.dispose();
		expect(animationClock.isRunning()).toBe(false);
	});

	it("never puts the banner on the clock", () => {
		const header = bannerHeader(colorTheme);
		const first = header.render(80);
		expect(animationClock.isRunning()).toBe(false);
		advance(1_500);
		expect(header.render(80)).toBe(first);
	});
});
