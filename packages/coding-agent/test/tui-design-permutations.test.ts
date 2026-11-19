import { animationClock, stripTerminalSequences, TuiMainScreen } from "@octocodeai/octocode-tui";
import { QaTerminal } from "../../tui/test/helpers/capture-terminal.ts";
import { afterAll, describe, expect, it } from "vitest";
import { setTerminalColors } from "../src/theme/theme-terminal.ts";
import { captureQa } from "./fixtures/tui-design-qa.ts";
import { QA_MATRIX, qaId } from "./fixtures/tui-design-qa-scene.ts";
import { QA_CALL_PURPOSES, QA_RESULT_PURPOSES } from "./fixtures/tui-design-qa-tools.ts";
import { qaTranscript } from "./fixtures/tui-design-qa-transcript.ts";

/** The message rows drawn alone at `width`, trimmed: rows a 24-row screen scrolls off. */
function messageRowsAt(width: number): string[] {
	const terminal = new QaTerminal(width);
	try {
		const document = qaTranscript(new TuiMainScreen(terminal), "transcript-messages");
		return document.render(width).map((line) => stripTerminalSequences(line).trim());
	} finally {
		terminal.emulator.dispose();
	}
}

afterAll(() => {
	animationClock.setReducedMotion(false);
	setTerminalColors({});
});

describe("production TUI terminal permutations", () => {
	it("covers each theme, width, screen mode and state exactly once", () => {
		expect(QA_MATRIX).toHaveLength(120);
		expect(new Set(QA_MATRIX.map(qaId)).size).toBe(120);
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
			// The title and one fact at the right; no count while the list does not scroll. The main screen pads the row
			// with one trailing column.
			expect(text).toMatch(/^ Resume session +this folder · recent ?$/m);
			expect(text).not.toContain("(1 of 3)");
			expect(text).toContain("TUI visual audit");
			expect(text).toContain("enter resume");
		} else if (config.state === "tool-queries" || config.state === "tool-results") {
			const unfolded = text.replace(/\s+/g, " ");
			// A 40-column result is taller than the 24-row screen: the top scrolls off and the tail (the result) stays.
			// The title is the tool word; its server follows as meta. Where the key argument and meta do not both fit, the
			// meta drops whole first: at 80 columns the argument shows whole, at 40 it is cut and the live clock stays.
			const header =
				config.width === 120
					? /^\S localSearch\(render in \/synthetic\/project, save in \/synthetic\/project\) · octocode\b/
					: config.width === 80
						? /^\S localSearch\(render in \/synthetic\/project, save in \/synthetic\/project\)( · \d+ms)?$/
						: /^\S localSearch\(render in \/synt\w*…\) · \d+ms$/;
			const headerShown = frame.text.some((line) => header.test(line.trim()));
			expect(text).not.toContain("mcp__octocode__");
			if (config.width !== 120) expect(text).not.toContain("· octocode");
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
		} else if (config.state === "transcript-tools") {
			// Every row in the one tool grammar: a word title, a state mark, the `⎿` outcome; no raw ids, emoji or brackets.
			const rows = frame.text.map((line) => line.trim());
			expect(rows).toContain("⏺ Bash(ls packages)");
			expect(rows).toContain("⎿  exit 0 · 3 lines");
			// At 40 columns the row cannot hold the meta too: it drops whole and the path stays uncut.
			expect(rows).toContain(
				config.width === 40 ? "⏺ File(edit src/render/tool.ts)" : "⏺ File(edit src/render/tool.ts) · 1 edit",
			);
			expect(rows).toContain("⎿  +1 -1");
			expect(rows).toContain("⏺ Agent(audit transcript rows)");
			// An outcome row drops its trailing meta parts whole, as a head row does: at 40 columns the tool count goes.
			expect(rows).toContain(config.width === 40 ? "⎿  Done · general-0001" : "⎿  Done · general-0001 · 14 tool calls");
			expect(text).not.toMatch(/⎿  Done[^\n]*…/);
			expect(rows).toContain("⏺ weird(a=1)");
			expect(rows).toContain("Call renderer failed: Error: boom");
			expect(text).not.toContain("🐙");
			expect(text).not.toContain("[exit");
		} else if (config.state === "transcript-messages") {
			const rows = frame.text.map((line) => line.trim());
			// At 40 columns the wrapped blocks below push the `!` row off the 24-row screen: its output tail stays, and
			// the head, which fits 40 columns whole, is checked drawn alone.
			const shell = config.width === 40 ? messageRowsAt(40) : rows;
			expect(shell).toContain("✓ ! ls packages · you · 1.4s");
			expect(shell).toContain("⎿  exit 0 · 4 lines · 24 B");
			if (config.width === 40) {
				for (const line of ["agent", "ai", "coding-agent", "tui"]) expect(rows).toContain(line);
				expect(rows).toContain("[compaction] 123k tokens → 8-token");
			}
			expect(text).toContain("[compaction] 123k tokens → ");
			expect(text).toContain("[skill] octocode-research · 3 lines");
			// A message body wraps instead of being cut.
			if (config.width === 40) {
				expect(rows).toContain("[wake] Timer fired: check the build");
				expect(rows).toContain("log.");
			} else expect(rows).toContain("[wake] Timer fired: check the build log.");
			// No frame around the `!` row: the rules on screen are the editor's two.
			expect(frame.text.filter((line) => line.startsWith("─"))).toHaveLength(2);
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
