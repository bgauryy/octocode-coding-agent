import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodePastedControlKeys } from "../src/bracketed-paste.ts";
import {
	detectMultiplexer,
	hasTmuxSession,
	resetMultiplexerCache,
	tmuxClientTermFeatures,
	tmuxClientTerminalNames,
	tmuxPaneAllowsPassthrough,
	wrapTmuxPassthrough,
} from "../src/multiplexer.ts";
import { type FakeTmux, type FakeTmuxReplies, installFakeTmux } from "./helpers/fake-tmux.ts";
import { killPrivateTmuxServer } from "./helpers/real-tmux.ts";

const TMUX_ENV = { TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3" };
let fake: FakeTmux | undefined;

function withFake(replies: FakeTmuxReplies): FakeTmux {
	fake = installFakeTmux(replies);
	return fake;
}

beforeEach(() => resetMultiplexerCache());
afterEach(() => {
	fake?.restore();
	fake = undefined;
});

describe("detectMultiplexer", () => {
	it("prefers session markers over TERM", () => {
		assert.equal(detectMultiplexer({ TMUX: "x", TERM: "screen" }), "tmux");
		assert.equal(detectMultiplexer({ STY: "1.pts", TERM: "tmux-256color" }), "screen");
		assert.equal(detectMultiplexer({ ZELLIJ: "0", TERM: "xterm" }), "zellij");
	});

	it("falls back to the TERM prefix", () => {
		assert.equal(detectMultiplexer({ TERM: "tmux-256color" }), "tmux");
		assert.equal(detectMultiplexer({ TERM: "Screen.xterm-256color" }), "screen");
		assert.equal(detectMultiplexer({ TERM: "xterm-256color" }), null);
		assert.equal(detectMultiplexer({}), null);
	});

	it("counts only TMUX as a tmux session", () => {
		assert.equal(hasTmuxSession({ TMUX: "/tmp/x,1,0" }), true);
		assert.equal(hasTmuxSession({ TERM: "tmux-256color" }), false);
		assert.equal(hasTmuxSession({ TMUX: "" }), false);
	});
});

describe("wrapTmuxPassthrough", () => {
	it("doubles every ESC inside the DCS envelope", () => {
		assert.equal(wrapTmuxPassthrough("\x1b]9;hi\x07"), "\x1bPtmux;\x1b\x1b]9;hi\x07\x1b\\");
		assert.equal(wrapTmuxPassthrough("\x1b_Ga\x1b\\"), "\x1bPtmux;\x1b\x1b_Ga\x1b\x1b\\\x1b\\");
	});
});

describe("tmux queries through a fake tmux", () => {
	it("reads the client terminal names, best first", () => {
		withFake({ clientTermtype: "kitty(0.35.2)", clientTermname: "xterm-kitty" });
		assert.deepEqual(tmuxClientTerminalNames(TMUX_ENV), ["kitty", "xterm-kitty"]);
		assert.deepEqual(tmuxClientTerminalNames(TMUX_ENV), ["kitty", "xterm-kitty"]);
		assert.equal(fake?.calls().length, 1, "the answer is cached");
	});

	it("asks again after an answer with no client attached", () => {
		const detached = installFakeTmux({ clientTermtype: "", clientTermname: "" });
		try {
			assert.deepEqual(tmuxClientTerminalNames(TMUX_ENV), []);
		} finally {
			detached.restore();
		}
		withFake({ clientTermtype: "ghostty 1.3.1", clientTermname: "xterm-ghostty" });
		assert.deepEqual(tmuxClientTerminalNames(TMUX_ENV), ["ghostty", "xterm-ghostty"]);
	});

	it("handles XTVERSION names with a space and a missing name", () => {
		withFake({ clientTermtype: "WezTerm 20240203", clientTermname: "" });
		assert.deepEqual(tmuxClientTerminalNames(TMUX_ENV), ["wezterm"]);
	});

	it("returns an empty list when tmux fails or is absent", () => {
		withFake({ fail: ["client", "features"] });
		assert.deepEqual(tmuxClientTerminalNames(TMUX_ENV), []);
		assert.deepEqual(tmuxClientTermFeatures(TMUX_ENV), []);
		const original = process.env.PATH;
		process.env.PATH = "/nonexistent";
		try {
			resetMultiplexerCache();
			assert.deepEqual(tmuxClientTermFeatures(TMUX_ENV), []);
			assert.equal(tmuxPaneAllowsPassthrough(TMUX_ENV), false);
		} finally {
			process.env.PATH = original;
		}
	});

	it("splits the client term features on commas", () => {
		withFake({ termfeatures: "256,hyperlinks, RGB" });
		assert.deepEqual(tmuxClientTermFeatures(TMUX_ENV), ["256", "hyperlinks", "RGB"]);
	});

	it("allows passthrough for on and all, and when tmux has no such option", () => {
		for (const [value, allowed] of [
			["on", true],
			["all", true],
			["off", false],
			[undefined, true],
		] as const) {
			resetMultiplexerCache();
			const f = installFakeTmux({ allowPassthrough: value });
			try {
				assert.equal(tmuxPaneAllowsPassthrough(TMUX_ENV), allowed, `allow-passthrough ${value}`);
				assert.match(f.calls()[0] ?? "", /show-options .*-t %3 allow-passthrough/);
			} finally {
				f.restore();
			}
		}
	});

	it("treats a failing show-options as not allowed", () => {
		withFake({ fail: ["passthrough"] });
		assert.equal(tmuxPaneAllowsPassthrough(TMUX_ENV), false);
	});

	it("caches per TMUX and TMUX_PANE", () => {
		withFake({ allowPassthrough: "on" });
		tmuxPaneAllowsPassthrough(TMUX_ENV);
		tmuxPaneAllowsPassthrough(TMUX_ENV);
		tmuxPaneAllowsPassthrough({ ...TMUX_ENV, TMUX_PANE: "%4" });
		assert.equal(fake?.calls().length, 2);
	});
});

describe("decodePastedControlKeys", () => {
	it("decodes the csi-u and xterm forms of Ctrl+letter", () => {
		assert.equal(decodePastedControlKeys("a\x1b[106;5ub"), "a\nb");
		assert.equal(decodePastedControlKeys("a\x1b[27;5;106~b"), "a\nb");
		assert.equal(decodePastedControlKeys("\x1b[27;5;74~\x1b[74;5u"), "\n\n");
		assert.equal(decodePastedControlKeys("\x1b[27;5;105~"), "\t");
	});

	it("leaves other sequences and plain text alone", () => {
		for (const text of ["plain", "\x1b[27;2;106~", "\x1b[106;2u", "\x1b[27;5;300~", "\x1b[1;5C"]) {
			assert.equal(decodePastedControlKeys(text), text);
		}
	});
});

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe("real tmux", { skip: !hasTmux && "tmux is not installed" }, () => {
	const socket = `octocode-test-${process.pid}`;
	const tmux = (...args: string[]) =>
		spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });

	afterEach(() => killPrivateTmuxServer(socket));

	it("reports the pane allow-passthrough option", () => {
		const started = tmux("new-session", "-d", "-s", "t", "-P", "-F", "#{pane_id} #{socket_path} #{pid}", "sleep 30");
		assert.equal(started.status, 0, started.stderr);
		const [pane, socketPath, pid] = started.stdout.trim().split(" ");
		const env = { TMUX: `${socketPath},${pid},0`, TMUX_PANE: pane };
		assert.equal(tmuxPaneAllowsPassthrough(env), false, "off by default");
		tmux("set-option", "-p", "-t", pane, "allow-passthrough", "on");
		resetMultiplexerCache();
		assert.equal(tmuxPaneAllowsPassthrough(env), true);
	});
});
