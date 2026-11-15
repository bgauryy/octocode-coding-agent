import { animationClock } from "@octocodeai/octocode-tui";
import { afterAll, describe, expect, it } from "vitest";
import { setTerminalColors } from "../src/theme/theme-terminal.ts";
import { captureQa } from "./fixtures/tui-design-qa.ts";
import { QA_MATRIX, qaId } from "./fixtures/tui-design-qa-scene.ts";
import { QA_CALL_PURPOSES, QA_RESULT_PURPOSES } from "./fixtures/tui-design-qa-tools.ts";

afterAll(() => {
	animationClock.setReducedMotion(false);
	setTerminalColors({});
});

describe("production TUI terminal permutations", () => {
	it("covers each theme, width, screen mode and state exactly once", () => {
		expect(QA_MATRIX).toHaveLength(96);
		expect(new Set(QA_MATRIX.map(qaId)).size).toBe(96);
	});

	it.each(QA_MATRIX)("$theme $width $mode $state", async (config) => {
		const frame = await captureQa(config);
		const text = frame.text.join("\n");
		expect(frame.renderer).toBe(config.mode === "regular" ? "TuiMainScreen" : "TuiAltScreen");
		expect(frame.componentOverflow).toEqual([]);
		expect(frame.cells).toHaveLength(frame.rows);
		for (const row of frame.cells) expect(row).toHaveLength(config.width);
		expect(frame.rows).toBe(24);
		expect(text).toContain("qa-model");
		expect(text).toContain("workspace");
		expect(text).toContain("ctx");
		if (config.width === 40) expect(text).toContain("/status");
		if (config.state === "session-picker") {
			expect(text).toContain("Resume session (1 of 3)");
			expect(text).toContain("TUI visual audit");
			expect(text).toContain("enter resume");
		} else if (config.state === "tool-queries" || config.state === "tool-results") {
			const unfolded = text.replace(/\s+/g, " ");
			// A 40-column result is taller than the 24-row screen: the top scrolls off and the tail (the result) stays.
			const headerShown = frame.text.some((line) => line.includes("mcp__octocode__localSearch"));
			expect(headerShown || (config.width === 40 && config.state === "tool-results")).toBe(true);
			if (config.state === "tool-results") expect(frame.text.some((line) => line.trim() === "Result")).toBe(true);
			if (headerShown) {
				// One `↳` purpose row per query, under the tool header.
				expect(frame.text.filter((line) => line.trim().startsWith("↳"))).toHaveLength(QA_CALL_PURPOSES.length);
				expect(unfolded).toMatch(/Query\s+1/);
				expect(unfolded).toMatch(/Query\s+2/);
			}
			const shownPurposes = [
				...(headerShown ? QA_CALL_PURPOSES : []),
				...(config.state === "tool-results" ? QA_RESULT_PURPOSES : []),
			];
			for (const purpose of shownPurposes) {
				expect(unfolded).toContain(purpose.mainGoal);
				expect(unfolded).toContain(purpose.reasoning);
			}
		} else {
			expect(text).toContain("Review rendering");
			expect(text).toContain("Useful data stays visible.");
		}
		if (config.state === "error") {
			expect(text).toContain("Error: database unavailable.");
			expect(text).toContain("Database unavailable");
			expect(text).toContain("remain in memory.");
			const row = frame.cells[frame.text.findIndex((line) => line.includes("Database unavailable"))];
			const letter = row.find((cell) => cell.chars === "D");
			expect(letter?.fg).not.toBeNull();
			const red = letter!.fg!;
			expect((red >> 16) & 255).toBeGreaterThan(red & 255);
		} else if (config.state === "warning") {
			expect(text).toContain("Warning: session save delayed.");
			expect(text).toContain("Session save delayed");
		} else if (config.state === "running") {
			expect(text).toContain("Working");
			expect(text.replace(/\s+/g, " ")).toContain("esc interrupt");
			expect(text).toMatch(/\b\d+s\b/);
		} else if (config.state === "queue") {
			expect(text).toContain("Queued");
			expect(text).toContain("Next turn");
			expect(text).toContain("After run");
		}
	});
});
