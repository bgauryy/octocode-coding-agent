/**
 * A finished `bash` tool row says how it ended in words and a mark, not by band tint alone (a 256-colour terminal loses
 * the tint): `✓ [exit 0 · 1.2s]`, `✗ [exit 1 · 0.4s]`, `◼ [aborted · 2s]`, with failure output in text colour.
 */
import { GLYPH } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolRenderContext } from "../src/core/features/types.ts";
import { createShellRenderers } from "../src/core/tools/renderers/bash.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const renderers = createShellRenderers("$");

function row(
	text: string,
	options: { isError?: boolean; durationMs?: number; details?: Record<string, unknown>; isPartial?: boolean },
): { plain: string; raw: string } {
	const context = {
		state: {},
		isPartial: options.isPartial ?? false,
		isError: options.isError ?? false,
		durationMs: options.durationMs,
		showImages: false,
		invalidate: () => {},
	} as unknown as ToolRenderContext;
	const component = renderers.renderResult!(
		{ content: [{ type: "text", text }], details: options.details },
		{ expanded: true, isPartial: options.isPartial ?? false },
		theme,
		context,
	);
	const raw = component.render(80).join("\n");
	return { plain: stripAnsi(raw), raw };
}

describe("bash tool row outcome", () => {
	beforeAll(() => initTheme("dark"));

	test("marks a success with a check, its exit code and time", () => {
		const { plain } = row("[exit 0 · 1.2s · 1 line · 3 B]\nok", { details: { exitCode: 0 } });
		expect(plain).toContain(`${GLYPH.done} [exit 0 · 1.2s`);
	});

	test("marks a failure with a cross and shows its output in text colour", () => {
		const { plain, raw } = row("[exit 1 · 0.4s · 1 line · 5 B]\nboom!", { isError: true, details: { exitCode: 1 } });
		expect(plain).toContain(`${GLYPH.failed} [exit 1 · 0.4s`);
		expect(raw).toContain(theme.fg("text", "boom!"));
	});

	test("marks an aborted run as stopped, not failed", () => {
		const { plain } = row("[aborted · 2s · no output]", { isError: true, details: { termination: "aborted" } });
		expect(plain).toContain(`${GLYPH.stopped} [aborted · 2s`);
	});

	test("builds the words from details and duration when the result has no header", () => {
		const { plain } = row("it broke", { isError: true, durationMs: 400, details: { exitCode: 2 } });
		expect(plain).toContain(`${GLYPH.failed} exit 2 · 400ms`);
	});

	test("shows no outcome while the command still runs", () => {
		const { plain } = row("partial", { isPartial: true });
		for (const glyph of [GLYPH.done, GLYPH.failed, GLYPH.stopped]) expect(plain).not.toContain(glyph);
	});
});
