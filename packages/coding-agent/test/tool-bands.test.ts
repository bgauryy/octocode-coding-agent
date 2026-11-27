import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSurfaceFills, setToolBands, surfaceFill, toolBand } from "../src/theme/bands.ts";
import { initTheme, theme } from "../src/theme/theme.ts";

describe("tool bands", () => {
	beforeEach(() => {
		vi.stubEnv("NO_COLOR", "");
		vi.stubEnv("TERM", "xterm-256color");
		vi.stubEnv("COLORTERM", "truecolor");
		initTheme("octocode-dark");
	});
	afterEach(() => {
		setToolBands(false);
		setSurfaceFills(false);
		vi.unstubAllEnvs();
	});

	it("leaves the terminal background alone by default", () => {
		expect(toolBand("success", "x")).toBe("\x1b[49mx\x1b[49m");
	});

	it("blends a quiet state color into the background when on, per state", () => {
		setToolBands(true);
		const success = toolBand("success", "x");
		const error = toolBand("error", "x");
		expect(success).toMatch(/^\x1b\[48;2;\d+;\d+;\d+mx\x1b\[49m$/);
		expect(success).not.toBe(error);
		// 6% of a saturated state color over black stays dark: every channel under 40.
		for (const channel of success.match(/48;2;(\d+);(\d+);(\d+)/)!.slice(1)) expect(Number(channel)).toBeLessThan(40);
	});

	it("keeps a theme's own tool backgrounds", () => {
		initTheme("dark");
		setToolBands(true);
		expect(toolBand("pending", "x")).not.toBe("\x1b[49mx\x1b[49m");
	});
});

describe("surface fills", () => {
	beforeEach(() => {
		vi.stubEnv("NO_COLOR", "");
		vi.stubEnv("TERM", "xterm-256color");
		vi.stubEnv("COLORTERM", "truecolor");
		initTheme("octocode-dark");
	});
	afterEach(() => {
		setSurfaceFills(false);
		vi.unstubAllEnvs();
	});

	it("paints the theme's own panel color by default", () => {
		expect(surfaceFill("user", "x")).toBe(theme.bg("userMessageBg", "x"));
		expect(surfaceFill("custom", "x")).toBe(theme.bg("customMessageBg", "x"));
	});

	it("blends a quiet tint on the terminal background when on, differing per panel", () => {
		setSurfaceFills(true);
		const user = surfaceFill("user", "x");
		expect(user).toMatch(/^\x1b\[48;2;\d+;\d+;\d+mx\x1b\[49m$/);
		expect(user).not.toBe(theme.bg("userMessageBg", "x"));
		expect(user).not.toBe(surfaceFill("custom", "x"));
		// 6% of a light text color over a dark background stays dark: every channel under 50.
		for (const channel of user.match(/48;2;(\d+);(\d+);(\d+)/)!.slice(1)) expect(Number(channel)).toBeLessThan(50);
	});

	it("keeps the theme's panel without color", () => {
		vi.stubEnv("NO_COLOR", "1");
		initTheme("octocode-dark");
		setSurfaceFills(true);
		expect(surfaceFill("user", "x")).toBe(theme.bg("userMessageBg", "x"));
	});
});
