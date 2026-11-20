import { stripTerminalSequences, TuiMainScreen } from "@octocodeai/octocode-tui";
import { QaTerminal } from "../../tui/test/helpers/capture-terminal.ts";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../src/theme/theme.ts";
import { qaTranscript } from "./fixtures/tui-design-qa-transcript.ts";

/** The stacked message blocks of the QA transcript drawn at `width`, each row without its trailing blanks. */
function rowsAt(width: number): string[] {
	const terminal = new QaTerminal(width);
	try {
		const document = qaTranscript(new TuiMainScreen(terminal), "transcript-messages");
		return document.render(width).map((line) => stripTerminalSequences(line).trimEnd());
	} finally {
		terminal.emulator.dispose();
	}
}

const SHELL = [
	"",
	" ✓ ! ls packages · you · 1.4s",
	"   ⎿  exit 0 · 4 lines · 24 B",
	"      agent",
	"      ai",
	"      coding-agent",
	"      tui",
];

describe("stacked message blocks", () => {
	beforeAll(() => initTheme("dark"));

	// One blank row above every block, none below: two blocks never stack two blank rows.
	it.each([
		[
			40,
			[
				...SHELL,
				"",
				" [compaction] 123k tokens → 10-token",
				" summary",
				" (ctrl+o to expand)",
				"",
				" [skill] octocode-research · 3 lines",
				" /synthetic/skills/octocode-research/S…",
				" (ctrl+o to expand)",
				"",
				" [wake] Timer fired: check the build",
				" log.",
			],
		],
		[
			80,
			[
				...SHELL,
				"",
				" [compaction] 123k tokens → 10-token summary (ctrl+o to expand)",
				"",
				" [skill] octocode-research · 3 lines",
				" /synthetic/skills/octocode-research/SKILL.md",
				" (ctrl+o to expand)",
				"",
				" [wake] Timer fired: check the build log.",
			],
		],
		[
			120,
			[
				...SHELL,
				"",
				" [compaction] 123k tokens → 10-token summary (ctrl+o to expand)",
				"",
				" [skill] octocode-research · 3 lines · /synthetic/skills/octocode-research/SKILL.md (ctrl+o to expand)",
				"",
				" [wake] Timer fired: check the build log.",
			],
		],
	])("draws one blank row between blocks at %i columns", (width, rows) => {
		expect(rowsAt(width)).toEqual(rows);
	});
});
