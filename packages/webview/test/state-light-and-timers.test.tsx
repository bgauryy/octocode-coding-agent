/** @vitest-environment jsdom */
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElapsed } from "../src/app/hooks.ts";
import { setClockSkew } from "../src/app/live/profiler/use-now.ts";
import { StateMark } from "../src/app/ui/StateMark.tsx";
import { CHROME_CSS } from "../src/styles/chrome.ts";

const NOW = 1_800_000_000_000;

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	setClockSkew(0);
});

describe("state marks", () => {
	it("turns the working spinner while running, a full dot under reduced motion, and never a half-filled shape", () => {
		const { container } = render(<StateMark state="running" />);
		const svg = container.querySelector("svg");
		expect(svg?.getAttribute("class")).toContain("mark-running");
		// An arc on a faint ring turns smoothly, the family of the page's `.spinner`.
		expect(svg?.querySelector(".mark-spinner")?.getAttribute("fill")).toBeNull();
		expect(CHROME_CSS).toMatch(/\.mark-spinner\s*\{[^}]*animation:\s*spin [\d.]+s linear infinite/);
		// No filled half circle (an arc closed with `Z` and filled) anywhere in the mark.
		for (const path of svg?.querySelectorAll("path") ?? []) expect(path.getAttribute("d")).not.toMatch(/Z$/);
		// Reduced motion hides the spinner and shows the full dot.
		expect(svg?.querySelector(".mark-still")?.getAttribute("fill")).toBe("currentColor");
		expect(CHROME_CSS).toMatch(
			/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.mark-running \.mark-spinner[^}]*display:\s*none[^}]*\}\s*\.mark-running \.mark-still\s*\{\s*display:\s*inline/,
		);
		expect(CHROME_CSS).toMatch(/\.mark-still\s*\{\s*display:\s*none/);
		expect(CHROME_CSS).not.toMatch(/\.mark-arc/);
	});

	it("holds every settled state steady: no pulse on done, failed or stopped; waiting pulses only a few seconds", () => {
		const rule = (name: string) => CHROME_CSS.match(new RegExp(`\\.${name}\\s*\\{[^}]*\\}`, "g"))?.join(" ") ?? "";
		for (const name of ["mark-done", "mark-failed", "mark-stopped", "mark-pending"])
			expect(rule(name)).not.toContain("animation");
		const waiting = rule("mark-waiting");
		expect(waiting).toMatch(/animation:\s*breathe [\d.]+s ease-in-out 2\b/);
		expect(waiting).not.toContain("infinite");
	});

	it("colours stopped red like failed", () => {
		expect(CHROME_CSS).toMatch(/\.mark-stopped\s*\{\s*--mark:\s*var\(--state-failed\)/);
	});
});

describe("elapsed timers", () => {
	beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] }));

	it("starts at the host's start, ticks each second while active, and counts on the host's clock under skew", () => {
		setClockSkew(5000);
		const hostStart = NOW - 5000;
		const { result } = renderHook(() => useElapsed(hostStart, true));
		expect(result.current).toBe(0);
		act(() => {
			vi.advanceTimersByTime(3000);
		});
		expect(result.current).toBe(3000);
	});

	it("freezes when the work ends and survives a re-render", () => {
		const { result, rerender } = renderHook(({ active }) => useElapsed(NOW, active), {
			initialProps: { active: true },
		});
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(result.current).toBe(2000);
		rerender({ active: false });
		act(() => {
			vi.advanceTimersByTime(5000);
		});
		expect(result.current).toBe(2000);
		rerender({ active: false });
		expect(result.current).toBe(2000);
	});

	it("shares one interval across timers", () => {
		const spy = vi.spyOn(globalThis, "setInterval");
		renderHook(() => useElapsed(NOW, true));
		renderHook(() => useElapsed(NOW, true));
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
