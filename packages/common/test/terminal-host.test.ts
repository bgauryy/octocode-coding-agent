import { describe, expect, it } from "vitest";
import { terminalHostFacts } from "../src/terminal-host.ts";

describe("terminalHostFacts", () => {
	it("names the emulator even under tmux, then tmux and SSH", () => {
		expect(terminalHostFacts({ TERM_PROGRAM: "tmux", KITTY_WINDOW_ID: "1", TMUX: "/tmp/t,1,0" })).toEqual([
			"kitty",
			"tmux",
		]);
		expect(terminalHostFacts({ TERM_PROGRAM: "ghostty", SSH_CONNECTION: "1 2 3 4" })).toEqual(["Ghostty", "SSH"]);
		expect(terminalHostFacts({ TERM_PROGRAM: "iTerm.app" })).toEqual(["iTerm2"]);
	});

	it("names the IDE whose terminal runs the process", () => {
		expect(terminalHostFacts({ TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "x" })).toEqual(["Cursor terminal"]);
		expect(terminalHostFacts({ TERM_PROGRAM: "vscode" })).toEqual(["VS Code terminal"]);
		expect(terminalHostFacts({ TERMINAL_EMULATOR: "JetBrains-JediTerm" })).toEqual(["JetBrains terminal"]);
	});

	it("says nothing for an unknown host", () => {
		expect(terminalHostFacts({})).toEqual([]);
		expect(terminalHostFacts({ TERM: "xterm-256color" })).toEqual([]);
	});
});
