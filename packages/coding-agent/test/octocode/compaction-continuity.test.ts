import { describe, expect, it } from "vitest";
import { USER_HEADING } from "../../src/core/compaction/summary-view.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { CONTINUITY_TYPE, carriedUserMessages, withoutCarriedNotes } from "../../src/octocode/compaction/continuity.ts";

const compaction = (id: string, fromHook: boolean) => ({ type: "compaction", id, fromHook }) as unknown as SessionEntry;
const note = (compactionId: string, content: string) =>
	({
		type: "custom_message",
		customType: CONTINUITY_TYPE,
		details: { compactionId },
		content,
	}) as unknown as SessionEntry;
const codeOwned = (omitted: number, ...messages: string[]) =>
	`Code-owned\n\n${USER_HEADING}\n${omitted > 0 ? `Earlier user messages not kept here: ${omitted} (saved).\n` : ""}${messages.map((text) => `<user-message>\n${text}\n</user-message>`).join("\n")}`;

describe("user messages carried into the next checkpoint", () => {
	const copied = { messages: ["Model copied only A"], omitted: 0 };

	it("prefers the code-owned continuity note of the latest compaction over what the default summary copied", () => {
		// The parent's repro: the fallback model copied an incomplete section.
		const branch = [compaction("c", false), note("c", codeOwned(0, "Keep exact B constraint"))];
		expect(carriedUserMessages(copied, branch)).toEqual({ messages: ["Keep exact B constraint"], omitted: 0 });
		// The omitted count comes from the note too.
		const withOmitted = [compaction("c", false), note("c", codeOwned(3, "B"))];
		expect(carriedUserMessages({ messages: ["A"], omitted: 9 }, withOmitted)).toEqual({
			messages: ["B"],
			omitted: 3,
		});
	});

	it("keeps the previous summary's own messages without a matching note", () => {
		expect(carriedUserMessages(copied, [compaction("c", false)])).toEqual(copied);
		expect(carriedUserMessages(undefined, [compaction("c", false)])).toEqual({ messages: [], omitted: 0 });
		// A stale note: it names an earlier compaction, or sits before the latest one.
		const stale = [compaction("old", false), compaction("c", false), note("old", codeOwned(0, "Stale"))];
		expect(carriedUserMessages(copied, stale)).toEqual(copied);
		const before = [compaction("old", false), note("old", codeOwned(0, "Stale")), compaction("c", false)];
		expect(carriedUserMessages(copied, before)).toEqual(copied);
	});

	it("leaves a successful Octocode summary's own section authoritative", () => {
		const own = { messages: ["From Octocode's summary"], omitted: 1 };
		const branch = [compaction("c", true), note("c", codeOwned(0, "Not for this compaction"))];
		expect(carriedUserMessages(own, branch)).toEqual(own);
	});
});

describe("continuity messages a later compaction carried on", () => {
	const message = (compactionId: string) => ({
		role: "custom",
		customType: CONTINUITY_TYPE,
		details: { compactionId },
	});
	const user = { role: "user", content: "Go on." };

	it("hides an earlier compaction's message once the latest one's summary or message carried it", () => {
		const [first, second] = [message("c1"), message("c2")];
		// Octocode's default summary with its own continuity message.
		expect(withoutCarriedNotes([first, user, second], "c2", false)).toEqual([user, second]);
		// Octocode's own summary carries the user messages itself.
		expect(withoutCarriedNotes([first, user], "c2", true)).toEqual([user]);
	});

	it("keeps it when nothing carried it on, and returns the same array when nothing is hidden", () => {
		const messages = [message("c1"), user];
		// Another extension's summary, or Octocode's default one without its continuity message.
		expect(withoutCarriedNotes(messages, "c2", false)).toBe(messages);
		expect(withoutCarriedNotes(messages, undefined, true)).toBe(messages);
		expect(withoutCarriedNotes(messages, "c1", true)).toBe(messages);
		// A message of this type without a compaction id is not a continuity note of any compaction.
		const odd = [{ role: "custom", customType: CONTINUITY_TYPE, details: {} }, user];
		expect(withoutCarriedNotes(odd, "c2", true)).toBe(odd);
	});
});
