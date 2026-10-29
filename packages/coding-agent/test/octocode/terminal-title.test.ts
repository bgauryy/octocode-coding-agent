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
		t.promptStart();
		expect(t.state).toBe("waiting");
		t.promptEnd();
		t.toolEnd("b");
		expect(t.state).toBe("thinking");
		t.settle("failed");
		expect(t.state).toBe("failed");
		t.seen();
		expect(t.state).toBe("idle");
	});

	it("keeps a run's state when the user returns mid-run, and reset forgets an open dialog", () => {
		const t = new TitleTracker();
		t.start();
		t.seen();
		expect(t.state).toBe("thinking");
		t.promptStart();
		t.reset();
		t.start();
		expect(t.state).toBe("thinking");
		t.promptEnd();
		expect(t.state).toBe("thinking");
	});
});
