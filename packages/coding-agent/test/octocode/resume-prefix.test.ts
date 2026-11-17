import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, getCurrentSystemMessage, type TranscriptContext } from "@octocodeai/octocode-ai";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { sectionFamilyText } from "../../src/core/system-prompt-spec.ts";
import { baseEnv, type Fixture, fixture, scriptedSession, withEnv } from "./agent-context/capture.ts";
import { restoreEnv } from "./e2e-headless.ts";

/**
 * A session resumed from disk in a new process must send its last request again as the prefix of its first one, so the
 * provider reads the whole conversation from cache. A project change made while the session was closed (an edited
 * AGENTS.md) is appended after the history as a section update, never written into the system prompt the history
 * follows.
 */
afterAll(restoreEnv);

const fixtures: Fixture[] = [];
afterEach(() => {
	for (const fx of fixtures.splice(0))
		fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** One prompt in a session on `manager`; returns the transcript the scripted model received. */
async function promptOnce(fx: Fixture, manager: SessionManager, text: string): Promise<TranscriptContext> {
	const { session, faux } = await scriptedSession(fx, { noMcp: true }, manager);
	try {
		let captured: TranscriptContext | undefined;
		faux.setResponses([
			(context: TranscriptContext) => {
				captured = structuredClone(context);
				return fauxAssistantMessage(`answer to ${text}`);
			},
		]);
		await session.prompt(text);
		if (!captured) throw new Error("The scripted model received no request");
		return captured;
	} finally {
		session.dispose?.();
	}
}

async function resumeAfter(change: (fx: Fixture) => void) {
	const fx = fixture();
	fixtures.push(fx);
	return withEnv(baseEnv(fx), async () => {
		const sessionDir = path.join(fx.root, "sessions");
		const manager = SessionManager.create(fx.cwd, sessionDir);
		const file = manager.getSessionFile()!;
		const before = await promptOnce(fx, manager, "first");
		change(fx);
		// A new process opens the file: nothing of the first session object survives.
		const after = await promptOnce(fx, SessionManager.open(file, sessionDir), "second");
		const shared = JSON.stringify(after.messages.slice(0, before.messages.length));
		const tail = after.messages.slice(before.messages.length);
		return { before, after, extendsPrefix: shared === JSON.stringify(before.messages), tail };
	});
}

const tailText = (tail: TranscriptContext["messages"]) => JSON.stringify(tail);

describe("a session resumed from disk", () => {
	it("opens its first request with the last request it sent before closing", async () => {
		const { before, extendsPrefix, tail } = await resumeAfter(() => {});
		expect(before.messages.length).toBeGreaterThan(1);
		expect(extendsPrefix).toBe(true);
		// Not vacuous: the resumed request carries the earlier answer and the new prompt after the shared prefix.
		expect(tailText(tail)).toContain("answer to first");
		expect(tailText(tail)).toContain("second");
		expect(tail.some((message) => message.role === "system")).toBe(false);
	}, 120_000);

	it("appends an AGENTS.md edited while it was closed after the history, as a project_context update", async () => {
		const { before, after, extendsPrefix, tail } = await resumeAfter((fx) =>
			fs.writeFileSync(path.join(fx.cwd, "AGENTS.md"), "# Example project\n\nKeep files under 200 lines.\n"),
		);
		expect(extendsPrefix).toBe(true);
		expect(tailText(before.messages)).not.toContain("Keep files under 200 lines.");
		const update = tail.filter((message) => message.role === "system");
		expect(update).toHaveLength(1);
		expect(tailText(update)).toContain("Keep files under 200 lines.");
		// The current prompt carries the edit; the opening system message the history follows does not.
		expect(sectionFamilyText(getCurrentSystemMessage(after.messages)?.sections ?? {}, "project_context")).toContain(
			"Keep files under 200 lines.",
		);
	}, 120_000);
});
