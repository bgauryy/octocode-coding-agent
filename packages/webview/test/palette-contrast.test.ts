import { expect, it } from "vitest";
import { BASE_CSS } from "../src/styles/base.ts";

type Theme = Record<string, string>;

/** Custom properties set to a hex colour or to another property in a rule body. */
function tokens(block: string): Theme {
	return Object.fromEntries(
		[...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
	);
}
const rootBlocks = [...BASE_CSS.matchAll(/:root \{([^}]*)\}/g)].map((match) => match[1]);
const light = tokens(rootBlocks[0]);
const dark = { ...light, ...tokens(rootBlocks[1]) };

const rgb = (hex: string) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
function resolve(theme: Theme, value: string): string {
	const reference = /^var\((--[\w-]+)\)$/.exec(value);
	return reference ? resolve(theme, theme[reference[1]]) : value;
}
const color = (theme: Theme, name: string) => resolve(theme, theme[name]);
/** `share` of `top` over `bottom`, as CSS `color-mix(in srgb, top share, bottom)` does. */
function mix(top: string, share: number, bottom: string): string {
	const channels = rgb(top).map((value, index) => Math.round(value * share + rgb(bottom)[index] * (1 - share)));
	return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
function luminance(hex: string): number {
	const [r, g, b] = rgb(hex).map((value) => {
		const channel = value / 255;
		return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(foreground: string, background: string): number {
	const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
	return (high + 0.05) / (low + 0.05);
}

const TEXT_TONES = ["--success", "--warning", "--danger", "--accent", "--tool", "--agent", "--text-2"];
const STATE_ICONS = [
	"--state-backlog",
	"--state-todo",
	"--state-ongoing",
	"--state-done",
	"--state-running",
	"--state-pending",
	"--state-waiting",
	"--state-failed",
	"--state-stopped",
];

for (const [name, theme] of [
	["light", light],
	["dark", dark],
] as const) {
	const c = (token: string) => color(theme, token);
	// The column lane colour of `.column`: surface-3 58% over the page background.
	const column = mix(c("--surface-3"), 0.58, c("--bg"));
	const surfaces = ["--surface", "--surface-2", "--bg"].map(c);

	it(`${name}: running text on every surface it appears on reaches 4.5:1`, () => {
		for (const token of ["--text", "--text-2", "--text-3"])
			for (const surface of surfaces)
				expect(ratio(c(token), surface), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5);
		for (const token of ["--text-3", "--text-2"])
			for (const surface of ["--surface-3", "--accent-soft"])
				expect(ratio(c(token), c(surface)), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5);
	});

	it(`${name}: badges, the connection pill and diffs reach 4.5:1 on their tints`, () => {
		for (const token of TEXT_TONES) {
			for (const surface of ["--surface", "--surface-2"])
				expect(ratio(c(token), mix(c(token), 0.1, c(surface))), `badge ${token} on ${surface}`).toBeGreaterThanOrEqual(
					4.5,
				);
			expect(ratio(c(token), mix(c(token), 0.1, c("--bg"))), `pill ${token}`).toBeGreaterThanOrEqual(4.5);
		}
		for (const token of ["--success", "--danger"])
			expect(ratio(c(token), mix(c(token), 0.12, c("--surface"))), `diff ${token}`).toBeGreaterThanOrEqual(4.5);
	});

	it(`${name}: state tokens reach 4.5:1 on cards, the page and board columns, so they can carry text`, () => {
		for (const token of STATE_ICONS)
			for (const surface of [c("--surface"), c("--surface-2"), c("--bg"), column])
				expect(ratio(c(token), surface), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5);
	});

	it(`${name}: one semantic state set, with waiting distinct from stopped`, () => {
		expect(c("--state-ongoing")).toBe(c("--state-running"));
		expect(c("--state-running")).toBe(c("--accent"));
		expect(c("--state-backlog")).toBe(c("--state-pending"));
		expect(c("--state-waiting")).toBe(c("--warning"));
		expect(c("--state-done")).toBe(c("--success"));
		expect(c("--state-failed")).toBe(c("--danger"));
		expect(c("--state-stopped")).not.toBe(c("--state-waiting"));
	});
}
