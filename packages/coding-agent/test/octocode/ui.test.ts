import { animationClock, Container, rgbColor, styleText } from "@octocodeai/octocode-tui";
import { describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/index.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { toolHeader } from "../../src/octocode/shared/render.ts";
import { BANNER_HEIGHT } from "../../src/octocode/ui/banner.ts";
import {
	bannerHeader,
	packageVersion,
	registerUi,
	spinnerFrames,
	themeRamp,
	tokensPerSecond,
} from "../../src/octocode/ui/chrome.ts";
import { fakeCtx, fakeHost, theme } from "./fake-host.ts";

/** A theme with concrete colours, styled as a truecolor terminal would be. */
const colorTheme = {
	...(theme as object),
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

describe("chrome", () => {
	it("draws the banner without touching the transcript's thinking visibility", async () => {
		initTheme("dark", false);
		const fake = fakeHost();
		registerUi(fake.api, false);
		const ctx = fakeCtx({ cwd: "/work/app" });
		await fake.emit("session_start", { reason: "resume" }, ctx);
		const chat = new Container();
		const message = new AssistantMessageComponent(
			{ role: "assistant", content: [{ type: "thinking", thinking: "Hidden thought." }] } as never,
			true,
		);
		chat.addChild(message);
		const setHidden = vi.spyOn(message, "setHideThinkingBlock");
		const setMouseHint = vi.spyOn(message, "setMouseHint");
		const header = (ctx.ui.header as (tui: unknown, theme: unknown) => { render(width: number): string[] })(
			{ children: [chat], requestRender: vi.fn(), mode: "fullscreen" },
			theme,
		);
		expect(header.render(80)).toHaveLength(BANNER_HEIGHT);
		// The user's hideThinkingBlock setting, owned by the host, stays in force.
		expect(setHidden).not.toHaveBeenCalled();
		expect(setMouseHint).not.toHaveBeenCalled();
		expect(message.render(80).join("\n")).not.toContain("Hidden thought.");
	});

	it("computes output tokens per second of streaming time", () => {
		expect(tokensPerSecond(400, 4_000)).toBe(100);
		expect(tokensPerSecond(0, 1_000)).toBeUndefined();
		expect(tokensPerSecond(400, 0)).toBeUndefined();
		// One chunk of a short reply: too brief to be a speed.
		expect(tokensPerSecond(10, 5)).toBeUndefined();
	});

	it("dresses the TUI once per session start: banner header, footer, spinner; speed after a run", async () => {
		const fake = fakeHost();
		registerUi(fake.api, false);
		expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
		expect([...fake.handlers.keys()]).toEqual(
			expect.arrayContaining(["agent_end", "agent_start", "message_end", "message_start", "session_start"]),
		);

		const ctx = fakeCtx({ cwd: "/work/app" });
		await fake.emit("session_start", { reason: "startup" }, ctx);
		expect(typeof ctx.ui.header).toBe("function");
		expect(ctx.ui.footer).toBeDefined();
		expect((ctx.ui as never as { indicator: { frames: string[] } }).indicator.frames).toHaveLength(10);
		// The hidden reasoning stub is one line the message itself draws; no extension label adds a second.
		expect((ctx.ui as never as { thinkingLabel?: string }).thinkingLabel).toBeUndefined();
		const requestRender = vi.fn();
		const header = (ctx.ui.header as (tui: unknown, theme: unknown) => { render(width: number): string[] })(
			{ requestRender, children: [] },
			theme,
		);
		const lines = header.render(120);
		expect(lines).toHaveLength(BANNER_HEIGHT);
		expect(lines[0]).toContain("█▀█");
		expect(lines.join("\n")).toContain("BETA version");
		// Static: building and drawing the header never asks for another frame.
		expect(requestRender).not.toHaveBeenCalled();
		expect(animationClock.isRunning()).toBe(false);
		// Nothing goes into the session, so /resume and /fork never replay it.
		expect(fake.entries).toEqual([]);

		const now = vi.spyOn(Date, "now");
		await fake.emit("agent_start", {}, ctx);
		now.mockReturnValue(1_000);
		await fake.emit("message_start", { message: { role: "assistant" } }, ctx);
		await fake.emit("message_start", { message: { role: "user" } }, ctx);
		now.mockReturnValue(3_000);
		await fake.emit("message_end", { message: { role: "assistant", usage: { output: 100 } } }, ctx);
		await fake.emit("message_end", { message: { role: "assistant", usage: { output: 999 } } }, ctx);
		now.mockRestore();
		await fake.emit("agent_end", { messages: [] }, ctx);
		expect(ctx.ui.statuses.get("octocode-speed")).toBe("50 tok/s");
		await fake.emit("agent_end", { messages: [] }, fakeCtx({ cwd: "/x", hasUI: false }));

		// Print and RPC modes get no header.
		const rpc = fakeCtx({ cwd: "/work/app", mode: "rpc" });
		await fake.emit("session_start", { reason: "startup" }, rpc);
		expect(rpc.ui.header).toBeUndefined();

		// Subagents get no chrome at all.
		const child = fakeHost();
		registerUi(child.api, true);
		expect(child.handlers.size).toBe(0);
	});

	it("stops row clocks at run end", async () => {
		const fake = fakeHost();
		registerUi(fake.api, false);
		const ctx = fakeCtx({ cwd: "/work/app" });
		await fake.emit("session_start", { reason: "resume" }, ctx);
		vi.useFakeTimers();
		try {
			const invalidate = vi.fn();
			toolHeader(theme, { executionStarted: true, isPartial: true, state: {}, invalidate }, "Bash", "x");
			// Positive control: while the call runs, its clock asks for a repaint; only agent_end stops it.
			vi.advanceTimersByTime(1_000);
			expect(invalidate).toHaveBeenCalled();
			invalidate.mockClear();
			await fake.emit("agent_end", { messages: [] }, ctx);
			vi.advanceTimersByTime(3_000);
			expect(invalidate).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("paints the banner and spinner along the theme gradient, and falls back to tokens without concrete colours", () => {
		expect(themeRamp(theme)).toBeUndefined();
		expect(spinnerFrames(theme)[0]).toBe("⠋");
		const ramp = themeRamp(colorTheme)!;
		expect(ramp(0, "x")).toMatch(/\u001b\[[0-9;]*1[;m].*x/);
		expect(ramp(0, "x")).not.toBe(ramp(1, "x"));
		expect(new Set(spinnerFrames(colorTheme)).size).toBe(10);
	});

	it("draws the banner once per width: the same lines object until the width or theme changes", () => {
		const header = bannerHeader(colorTheme);
		const first = header.render(120);
		expect(header.render(120)).toBe(first);
		expect(header.render(80)).not.toBe(first);
		expect(animationClock.isRunning()).toBe(false);
	});

	it("repaints the banner in the new colours after invalidate (a theme change)", () => {
		const live = { ...(colorTheme as object), colors: { ...(colorTheme as { colors: object }).colors } };
		const header = bannerHeader(live as never);
		const before = header.render(120);
		live.colors = {
			...live.colors,
			accent: rgbColor(255, 0, 0),
			borderAccent: rgbColor(255, 0, 0),
			mdLink: rgbColor(255, 0, 0),
			syntaxOperator: rgbColor(255, 0, 0),
		};
		header.invalidate();
		const after = header.render(120);
		expect(after).not.toEqual(before);
		expect(after.join("\n")).toContain("255;0;0");
	});
});
