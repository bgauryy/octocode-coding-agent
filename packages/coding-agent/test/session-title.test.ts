import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { cleanTitle, sessionTitle } from "../src/core/session-manager/title.ts";
import { hasSessionName } from "../src/modes/interactive/components/session-selector-search.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function savedSession(): { manager: SessionManager; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-title-"));
	dirs.push(dir);
	const manager = SessionManager.create(dir, dir);
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "fix the resume picker" }], timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	return { manager, dir };
}

describe("session titles", () => {
	it("turns a skill invocation into skill-name: request", () => {
		const prompt = `<skill name="octocode-architect" location="/x/SKILL.md">\nReferences are relative to /x.\n\n# Body\n</skill>\n\nreview   the\nRFC`;
		expect(cleanTitle(prompt)).toBe("octocode-architect: review the RFC");
		expect(cleanTitle(`<skill name="a" location="/a">\nbody\n</skill>`)).toBe("a");
	});

	it("strips control characters, collapses whitespace and caps the length", () => {
		expect(cleanTitle("a\u001b[31m\tb\n\nc")).toBe("a b c");
		const long = cleanTitle("x".repeat(100));
		expect([...long]).toHaveLength(60);
		expect(long.endsWith("…")).toBe(true);
	});

	it("prefers the name over the first prompt", () => {
		expect(sessionTitle({ name: "Picker work", firstMessage: "hello" })).toBe("Picker work");
		expect(sessionTitle({ name: "  ", firstMessage: "hello" })).toBe("hello");
	});

	it("records who named the session, and only user names count as named", async () => {
		const { manager, dir } = savedSession();
		manager.appendSessionInfo("Fix resume picker", "auto");
		expect(manager.getSessionName()).toBe("Fix resume picker");
		expect(manager.getSessionNameSource()).toBe("auto");
		let [listed] = await SessionManager.list(dir, dir);
		expect(listed.name).toBe("Fix resume picker");
		expect(listed.nameSource).toBe("auto");
		expect(hasSessionName(listed)).toBe(false);

		manager.appendSessionInfo("My picker");
		expect(manager.getSessionNameSource()).toBe("user");
		[listed] = await SessionManager.list(dir, dir);
		expect(listed.name).toBe("My picker");
		expect(listed.nameSource).toBeUndefined();
		expect(hasSessionName(listed)).toBe(true);
		const lines = fs.readFileSync(manager.getSessionFile()!, "utf8").trim().split("\n");
		expect(JSON.parse(lines.at(-1)!)).not.toHaveProperty("source");
	});
});
