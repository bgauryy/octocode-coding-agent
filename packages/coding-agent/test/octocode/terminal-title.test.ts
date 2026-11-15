import { describe, expect, it } from "vitest";
import { TITLE_MARK, TitleTracker, terminalTitle } from "../../src/octocode/ui/terminal-title.ts";

describe("terminalTitle", () => {
	it("prefixes one mark per state and leaves idle plain", () => {
		expect(terminalTitle("idle", undefined, "/work/repo")).toBe("Octocode · repo");
		expect(terminalTitle("thinking", "fix login", "/work/repo")).toBe("✻ Octocode · fix login · repo");
		expect(Object.values(TITLE_MARK).filter(Boolean)).toEqual(["✻", "◐", "◇", "✓", "✗"]);
	});

	it("drops escape sequences from the session name", () => {
		expect(terminalTitle("done", "fix \u001b]0;pwned\u0007login", "/work/repo")).toBe("✓ Octocode · fix login · repo");
	});
});

describe("TitleTracker", () => {
	it("follows a run: thinking, running while any tool runs, waiting on a dialog, then the outcome until seen", () => {
		const t = new TitleTracker();
		t.toolStart("before-run");
		expect(t.state).toBe("idle");
		t.start();
		expect(t.state).toBe("thinking");
		t.toolStart("a");
		t.toolStart("b");
		t.toolEnd("a");
		expect(t.state).toBe("running");
		t.promptStart("p");
		expect(t.state).toBe("waiting");
		t.promptEnd("p");
		t.toolEnd("b");
		expect(t.state).toBe("thinking");
		t.settle("failed");
		expect(t.state).toBe("failed");
		t.seen();
		expect(t.state).toBe("idle");
	});

	it("adds an octopus with the number of background subagents after the state mark", () => {
		expect(terminalTitle("running", undefined, "/work/repo", 1)).toBe("◐ 🐙 Octocode · repo");
		expect(terminalTitle("thinking", "fix", "/work/repo", 3)).toBe("✻ 🐙3 Octocode · fix · repo");
		expect(terminalTitle("running", undefined, "/work/repo", 0)).toBe("◐ Octocode · repo");
	});

	it("stays running while background work outlives the run, and shows the outcome when the last of it ends", () => {
		const title = new TitleTracker();
		title.start();
		title.setBackground(2);
		title.settle("failed");
		expect(title.state).toBe("running");
		title.seen();
		expect(title.state).toBe("running");
		title.setBackground(0);
		expect(title.state).toBe("failed");
		title.seen();
		expect(title.state).toBe("idle");
	});

	it("shows waiting for a blocking dialog with no run active, and ignores a dialog the user opened", () => {
		const t = new TitleTracker();
		t.promptStart("picker", false);
		expect(t.state).toBe("idle");
		t.promptEnd("picker");
		t.promptStart("approval", true);
		expect(t.state).toBe("waiting");
		t.setBackground(1);
		expect(t.state).toBe("waiting");
		t.promptEnd("approval");
		expect(t.state).toBe("running");
	});

	it("keeps waiting while any blocking dialog is open, whatever order dialogs open and close in", () => {
		const t = new TitleTracker();
		expect(t.promptStart("picker", false)).toBe(false);
		expect(t.promptStart("approval", true)).toBe(true);
		expect(t.state).toBe("waiting");
		t.promptEnd("picker");
		expect(t.state).toBe("waiting");
		expect(t.promptStart("question", true)).toBe(false);
		t.promptEnd("approval");
		expect(t.state).toBe("waiting");
		t.promptEnd("question");
		expect(t.state).toBe("idle");
	});

	it("keeps a run's state when the user returns mid-run, and reset forgets an open dialog", () => {
		const t = new TitleTracker();
		t.start();
		t.seen();
		expect(t.state).toBe("thinking");
		t.promptStart("p");
		t.reset();
		t.start();
		expect(t.state).toBe("thinking");
		t.promptEnd("p");
		expect(t.state).toBe("thinking");
	});
});
