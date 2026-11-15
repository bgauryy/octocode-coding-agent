import { setKeybindings, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/theme/theme.ts";

const session: SessionInfo = {
	path: "/tmp/selector-feedback.jsonl",
	id: "feedback",
	cwd: "/tmp",
	created: new Date(0),
	modified: new Date(0),
	messageCount: 1,
	firstMessage: "Fix authentication",
	allMessagesText: "Fix authentication",
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("session picker feedback", () => {
	const opened: SessionSelectorComponent[] = [];
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => {
		for (const picker of opened.splice(0)) picker.dispose();
	});

	it("distinguishes an unmatched search from an empty session history", async () => {
		const picker = new SessionSelectorComponent(
			async () => [session],
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
		);
		opened.push(picker);
		await flush();
		picker.getSessionList().setQuery("unmatched");
		const output = picker.render(120).join("\n");
		expect(output).toContain('No sessions match "unmatched"');
		expect(output).not.toContain("No sessions in current folder");
		picker.getSessionList().setQuery("");
		expect(picker.getSessionList().getSelectedSessionPath()).toBe(session.path);
	});

	it("renders load errors as a single safe status row", async () => {
		const picker = new SessionSelectorComponent(
			async () => {
				throw new Error("A\nB\tC\x1b]52;c;cHduZWQ=\x07\x1b[2J\u009b2J\u202eD");
			},
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
		);
		opened.push(picker);
		await flush();
		const lines = picker.render(120);
		expect(lines.join("\n")).toContain("Failed to load sessions: A B C");
		for (const line of lines) expect(line).not.toMatch(/\x1b\]|\x1b\[2J|[\r\n\t\u009b\u202e]/u);
	});

	it.each([0, 1, 2, 3, 4])("keeps an empty picker within %i terminal columns", async (width) => {
		const picker = new SessionSelectorComponent(
			async () => [],
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
		);
		opened.push(picker);
		await flush();
		for (const line of picker.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});
