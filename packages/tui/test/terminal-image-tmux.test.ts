import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetMultiplexerCache } from "../src/multiplexer.ts";
import {
	detectCapabilities,
	getCapabilities,
	kittyPlaceholderMode,
	resetCapabilitiesCache,
	setCellDimensions,
} from "../src/terminal-image/capabilities.ts";
import { type FakeTmux, type FakeTmuxReplies, installFakeTmux } from "./helpers/fake-tmux.ts";

const ENV_KEYS = [
	"TMUX",
	"TMUX_PANE",
	"TERM",
	"TERM_PROGRAM",
	"COLORTERM",
	"KITTY_WINDOW_ID",
	"OCTOCODE_IMAGE_PROTOCOL",
];
const saved: Record<string, string | undefined> = {};
let fake: FakeTmux | undefined;

function inTmux(replies: FakeTmuxReplies, env: Record<string, string> = {}): void {
	fake = installFakeTmux(replies);
	process.env.TMUX = "/tmp/tmux-1/default,1,0";
	process.env.TMUX_PANE = "%1";
	Object.assign(process.env, env);
	resetMultiplexerCache();
	resetCapabilitiesCache();
}

beforeEach(() => {
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	for (const key of ENV_KEYS) delete process.env[key];
	setCellDimensions({ widthPx: 10, heightPx: 20 });
});
afterEach(() => {
	fake?.restore();
	fake = undefined;
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	resetMultiplexerCache();
	resetCapabilitiesCache();
});

const KITTY = {
	clientTermtype: "kitty(0.35.2)",
	clientTermname: "xterm-kitty",
	termfeatures: "256,RGB",
	allowPassthrough: "on",
};

describe("Kitty images inside tmux: capabilities", () => {
	it("enables Kitty for a Kitty client with passthrough and RGB", () => {
		inTmux(KITTY);
		assert.equal(getCapabilities().images, "kitty");
		assert.equal(kittyPlaceholderMode(), true);
	});

	it("enables Kitty for a Ghostty client", () => {
		inTmux({ ...KITTY, clientTermtype: "ghostty 1.1.0", clientTermname: "xterm-ghostty" });
		assert.equal(getCapabilities().images, "kitty");
	});

	it("accepts the truecolor hint when the client lists no RGB feature", () => {
		inTmux({ ...KITTY, termfeatures: "256" }, { COLORTERM: "truecolor" });
		assert.equal(getCapabilities().images, "kitty");
		resetCapabilitiesCache();
		delete process.env.COLORTERM;
		assert.equal(getCapabilities().images, null);
	});

	it("keeps images off without passthrough", () => {
		for (const allowPassthrough of ["off"]) {
			inTmux({ ...KITTY, allowPassthrough });
			assert.equal(getCapabilities().images, null);
		}
		inTmux({ ...KITTY, fail: ["passthrough"] });
		assert.equal(getCapabilities().images, null);
		assert.equal(kittyPlaceholderMode(), false);
	});

	it("treats an absent allow-passthrough option (tmux before 3.3) as allowed", () => {
		inTmux({ ...KITTY, allowPassthrough: undefined });
		assert.equal(getCapabilities().images, "kitty");
	});

	it("keeps images off for clients without placeholders", () => {
		for (const [clientTermtype, clientTermname] of [
			["WezTerm 20240203", "xterm-256color"],
			["iTerm2 3.5", "xterm-256color"],
			["", "xterm-256color"],
		]) {
			inTmux({ ...KITTY, clientTermtype, clientTermname }, { TERM_PROGRAM: "kitty", KITTY_WINDOW_ID: "1" });
			assert.equal(getCapabilities().images, null, clientTermtype);
		}
	});

	it("lets OCTOCODE_IMAGE_PROTOCOL force or disable Kitty", () => {
		inTmux(
			{ ...KITTY, clientTermtype: "", clientTermname: "xterm-256color", allowPassthrough: "off" },
			{
				OCTOCODE_IMAGE_PROTOCOL: "kitty",
			},
		);
		assert.equal(getCapabilities().images, "kitty");
		assert.equal(kittyPlaceholderMode(), true);
		inTmux(KITTY, { OCTOCODE_IMAGE_PROTOCOL: "none" });
		assert.equal(getCapabilities().images, null);
		assert.equal(kittyPlaceholderMode(), false);
	});

	it("does not use placeholders outside tmux", () => {
		process.env.KITTY_WINDOW_ID = "1";
		resetCapabilitiesCache();
		assert.equal(detectCapabilities().images, "kitty");
		assert.equal(kittyPlaceholderMode(), false);
	});
});

describe("hyperlinks inside tmux", () => {
	it("emits OSC 8 links only when the client lists the hyperlinks feature", () => {
		inTmux({ ...KITTY, termfeatures: "256,hyperlinks,RGB" });
		assert.equal(getCapabilities().hyperlinks, true);
		inTmux({ ...KITTY, termfeatures: "256,RGB" });
		assert.equal(getCapabilities().hyperlinks, false);
	});

	it("keeps links off when tmux cannot name the client features", () => {
		inTmux({ ...KITTY, fail: ["features"] });
		assert.equal(getCapabilities().hyperlinks, false);
	});
});
