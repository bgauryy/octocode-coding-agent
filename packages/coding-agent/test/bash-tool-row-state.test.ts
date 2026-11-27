/**
 * A finished core `bash` row draws the shared shell grammar: the header's mark says how it ended (a 256-colour terminal
 * loses the band tint), the `⎿` line says it in words (`exit 0 · 1 line`), and the duration shows once, in the header.
 */
import { GLYPH } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolRenderContext } from "../src/core/features/types.ts";
import { withBuiltInRenderers } from "../src/octocode/files/built-in-renderers.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const renderers = withBuiltInRenderers("bash", undefined)!;

function row(
	text: string,
	options: { isError?: boolean; durationMs?: number; details?: Record<string, unknown>; isPartial?: boolean },
): { header: string; result: string; raw: string; rawHeader: string } {
	const context = {
		args: { command: "make" },
		state: {},
		executionStarted: true,
		isPartial: options.isPartial ?? false,
		isError: options.isError ?? false,
		durationMs: options.durationMs,
		showImages: false,
		expanded: true,
		invalidate: () => {},
	} as unknown as ToolRenderContext;
	const raw = renderers.renderResult!(
		{ content: [{ type: "text", text }], details: options.details },
		{ expanded: true, isPartial: options.isPartial ?? false },
		theme,
		context,
	)
		.render(80)
		.join("\n");
	// Drawn after the result, as a redraw is: a stop the result found shows in the header's mark.
	const rawHeader = renderers.renderCall!({ command: "make" }, theme, context).render(80).join("\n");
	const header = stripAnsi(rawHeader);
	return { header, result: stripAnsi(raw), raw, rawHeader };
}

describe("core bash tool row outcome", () => {
	beforeAll(() => initTheme("dark"));

	test("marks a success with the done light and says its exit code; the time is in the header only", () => {
		const { header, result, rawHeader } = row("[exit 0 · 1.2s · 1 line · 3 B]\nok", {
			details: { exitCode: 0 },
			durationMs: 1_200,
		});
		expect(header).toBe("◉ Bash(make) · 1.2s");
		expect(rawHeader).toContain(theme.fg("success", "◉"));
		expect(result).toContain("⎿  exit 0 · 1 line");
		expect(result).not.toContain("1.2s");
	});

	test("marks a failure with the failed light and shows its output in the error colour", () => {
		const { header, result, raw, rawHeader } = row("[exit 1 · 0.4s · 1 line · 5 B]\nboom!", {
			isError: true,
			details: { exitCode: 1 },
		});
		// A settled row draws its state's light: ⏺ means running only.
		expect(header.startsWith("⊗ Bash(make)")).toBe(true);
		expect(rawHeader).toContain(theme.fg("error", "⊗"));
		expect(result).toContain("⎿  Error: exit 1 · 1 line");
		expect(raw).toContain(theme.fg("error", "boom!"));
	});

	test("marks an aborted run as stopped, not failed", () => {
		const { header, result } = row("[aborted · 2s · no output]", {
			isError: true,
			details: { termination: "aborted" },
		});
		expect(header.startsWith("⊘ Bash(make)")).toBe(true);
		expect(result).toContain("⎿  aborted");
	});

	test("builds the words from the details when the result has no status line", () => {
		const { header, result } = row("it broke", { isError: true, durationMs: 400, details: { exitCode: 2 } });
		expect(result).toContain("exit 2 · 1 line");
		// Under a second, a finished row shows no time.
		expect(header).not.toContain("400ms");
	});

	test("shows no outcome mark while the command still runs", () => {
		const { result, rawHeader } = row("partial", { isPartial: true });
		expect(rawHeader).toContain(theme.fg("muted", "⏺"));
		for (const glyph of [GLYPH.done, GLYPH.failed, GLYPH.stopped]) expect(result).not.toContain(glyph);
		expect(result).toContain("running · 1 line");
	});
});
