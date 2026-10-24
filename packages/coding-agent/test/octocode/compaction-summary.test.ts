import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as SpillModule from "../../src/octocode/shared/spill.ts";

const savedTexts = vi.hoisted(() => [] as string[]);
vi.mock("../../src/octocode/shared/spill.ts", async (original) => ({
	...(await original<typeof SpillModule>()),
	saveFullOutput: (text: string) => {
		savedTexts.push(text);
		return `/checkpoint-${savedTexts.length}.txt`;
	},
}));
import { COMPACTION_NOTE_TYPE } from "../../src/octocode/compaction/record.ts";
import {
	carryFileLists,
	SUMMARIZER_RESULT_CHARS,
	SUMMARY_FOCUS,
	splitSummary,
	summarizerView,
	transcriptNote,
	USER_MESSAGE_CHARS,
	USER_MESSAGES_CHARS,
	USER_MESSAGES_SHARE,
	userMessagesSection,
	userText,
	windowBudget,
	writeSummary,
} from "../../src/octocode/compaction/summary.ts";

const fileOps = () => ({ read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() });

describe("compaction summary", () => {
	it("includes the built-in recovery sections", () => {
		for (const section of ["## Errors & Fixes", "## Where We Stopped", "## Follow-ups", "## TL;DR"])
			expect(SUMMARY_FOCUS).toContain(section);
		expect(SUMMARY_FOCUS).toMatch(
			/\n## TL;DR\nOne or two lines on what the messages above did[^\n]*"Topics: " with 3 to 8 comma-separated keywords/,
		);
		expect(SUMMARY_FOCUS).toMatch(/except ## TL;DR: write it afresh/);
		expect(SUMMARY_FOCUS).toMatch(/only record/);
		expect(SUMMARY_FOCUS).toMatch(/appended after your summary word for word by code, so do not copy them/);
	});

	it("names the transcript and the backlog only when there are ones", () => {
		const file = path.join(os.homedir(), "s", "a.jsonl");
		expect(transcriptNote(undefined, false)).toBe("");
		expect(transcriptNote(file, false)).toBe(
			`\n\n## Recovery\n- The full transcript before this summary is ~/s/a.jsonl (JSONL, one entry per line): search it for an exact message, error or tool result instead of guessing.`,
		);
		expect(transcriptNote(undefined, true)).toBe(
			"\n\n## Recovery\n- Record follow-ups that must outlive this session with `backlog`.",
		);
	});

	it("puts the archive pointer lines first in Recovery, then the transcript as the fallback, then the backlog line, one bullet each", () => {
		const note = transcriptNote("/s/a.jsonl", true, ["archive is in /a", "9-abc.md \u00b7 tldr"]);
		expect(note.split("\n").slice(3)).toEqual([
			"- archive is in /a",
			"- 9-abc.md \u00b7 tldr",
			"- If the archive does not have it, the full transcript is /s/a.jsonl (JSONL, one entry per line).",
			"- Record follow-ups that must outlive this session with `backlog`.",
		]);
		expect(transcriptNote(undefined, false, ["only this"])).toBe("\n\n## Recovery\n- only this");
		// A rewritten summary does not carry the section back: it is cut off by its bullet shape.
		expect(splitSummary(`## Goal\nx${note}`).body).toBe("## Goal\nx");
	});

	it("carries the file lists of the latest compaction only when a hook wrote it (Octocode carries its own)", () => {
		const compaction = (fromHook: boolean, readFiles: unknown, modifiedFiles: unknown) => ({
			type: "compaction",
			fromHook,
			details: { readFiles, modifiedFiles },
		});
		const ops = fileOps();
		carryFileLists({ fileOps: ops }, [
			compaction(true, ["old.ts"], ["old-mod.ts"]),
			compaction(true, ["a.ts", 7], ["b.ts"]),
			{ type: "message" },
		] as never);
		expect([...ops.read]).toEqual(["a.ts"]);
		expect([...ops.edited]).toEqual(["b.ts"]);
		const pi = fileOps();
		carryFileLists({ fileOps: pi }, [compaction(false, ["a.ts"], ["b.ts"])] as never);
		carryFileLists({ fileOps: pi }, [] as never);
		expect(pi.read.size + pi.edited.size).toBe(0);
	});

	it("leaves the summary to Octocode without a model, after an abort, or when the call fails, and records why in the session", async () => {
		const notes: unknown[] = [];
		const pi = {
			getThinkingLevel: () => "off",
			getActiveTools: () => [],
			getSettings: () => ({}),
			createUsageRecorder: () => () => {},
			appendEntry: (customType: string, data: unknown) => notes.push({ customType, data }),
		} as never;
		const event = (aborted = false) =>
			({
				preparation: {
					messagesToSummarize: [],
					turnPrefixMessages: [],
					fileOps: fileOps(),
					settings: { reserveTokens: 1000 },
				},
				branchEntries: [],
				signal: { aborted },
			}) as never;
		const notices: string[] = [];
		const ctx = (model: unknown) =>
			({
				model,
				modelRegistry: {
					streamSimple: () => {
						throw new Error("down");
					},
				},
				sessionManager: {
					getSessionFile: () => undefined,
					getSessionId: () => "s",
					getBranch: () => [],
					buildSessionProjection: () => ({ entries: [], messages: [] }),
				},
				hasUI: true,
				ui: { notify: (text: string) => notices.push(text) },
			}) as never;
		expect(await writeSummary(pi, event(), ctx(undefined))).toBeUndefined();
		expect(notes).toEqual([
			{
				customType: COMPACTION_NOTE_TYPE,
				data: { kind: "default-summary", reason: "no model is selected for the summary" },
			},
		]);
		// A cancel is the user's own: no default summary follows, so nothing is recorded or shown.
		expect(await writeSummary(pi, event(true), ctx({ id: "m" }))).toBeUndefined();
		expect(notes).toHaveLength(1);
		expect(notices).toEqual([]);
		expect(
			await writeSummary(pi, event(), ctx({ id: "m", provider: "p", api: "x", maxTokens: 100, contextWindow: 1000 })),
		).toBeUndefined();
		expect(notices.at(-1)).toMatch(/compaction summary failed .*Octocode writes its default summary/);
		expect(notes).toHaveLength(2);
		expect(notes[1]).toMatchObject({
			customType: COMPACTION_NOTE_TYPE,
			data: {
				kind: "default-summary",
				reason: expect.stringMatching(/^Octocode's compaction summary failed \(.+\)$/),
			},
		});
	});

	it("splits a summary it wrote into the model part, the kept user messages and the note; any other summary is all body", () => {
		const note = transcriptNote("/s/a.jsonl", true);
		const section = userMessagesSection([], 2, ["first ask", "then this"]);
		const split = splitSummary(`## Goal\nx\n\n<read-files>\na\n</read-files>${section}${note}`);
		// Code re-appends the file lists from the compaction's details, so the model never sees the stale ones.
		expect(split).toEqual({
			body: "## Goal\nx",
			messages: ["first ask", "then this"],
			omitted: 2,
		});
		expect(splitSummary("## Goal\nx\n\n## Recovery\nkept prose")).toEqual({
			body: "## Goal\nx\n\n## Recovery\nkept prose",
			messages: [],
			omitted: 0,
		});
	});

	it("reads a user message's text, marking images; other roles are not the user's", () => {
		expect(userText({ role: "user", content: "do it" })).toBe("do it");
		expect(
			userText({
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", data: "x", mimeType: "image/png" },
				],
			}),
		).toBe("look\n[image attached]");
		expect(userText({ role: "custom", content: "injected" })).toBeUndefined();
		// A skill Octocode expanded into the message is a pointer to its file, not part of the user's words.
		const skill =
			'<skill name="review" location="/home/u/.octocode/skills/review/SKILL.md">\nReferences are relative to /home/u/.octocode/skills/review.\n\n# Review\n' +
			"step\n".repeat(2_000) +
			"</skill>";
		expect(userText({ role: "user", content: `${skill}\n\ncheck src/a.ts` })).toBe(
			"[skill review loaded from /home/u/.octocode/skills/review/SKILL.md]\n\ncheck src/a.ts",
		);
		expect(userText({ role: "user", content: [{ type: "text", text: skill }] })).toBe(
			"[skill review loaded from /home/u/.octocode/skills/review/SKILL.md]",
		);
		expect(userText({ role: "user", content: 'I typed <skill name="x"> by hand' })).toBe(
			'I typed <skill name="x"> by hand',
		);
		expect(userText({ role: "assistant", content: [{ type: "text", text: "mine" }] })).toBeUndefined();
	});

	it("keeps user messages whole or saves the complete collection and a reference", () => {
		const long = `HEAD${"x".repeat(USER_MESSAGE_CHARS * 2)}TAIL`;
		const section = userMessagesSection([], 0, [long]);
		expect(section).toContain("Complete text saved at");
		expect(savedTexts.at(-1)).toContain(long);
		const many = Array.from({ length: 20 }, (_, i) => `${i}:${"y".repeat(USER_MESSAGE_CHARS)}`);
		const kept = userMessagesSection(["older kept"], 4, many);
		expect(kept.length).toBeLessThanOrEqual(USER_MESSAGES_CHARS);
		for (const message of ["older kept", ...many]) expect(savedTexts.at(-1)).toContain(message);
		expect(splitSummary(kept).omitted).toBe(4);
		expect(splitSummary(userMessagesSection([], 0, ["a </user-message> b"])).messages).toEqual([
			"a <\\/user-message> b",
		]);
		expect(userMessagesSection([], 0, [])).toBe("");
	});

	it("persists the complete tool result before giving the summarizer a reference", () => {
		const log = `START ${".".repeat(10_000)} FAILED: expected 2 got 3`;
		const image = { type: "image", data: "x", mimeType: "image/png" };
		const messages = [
			{ role: "toolResult", toolCallId: "t", content: [{ type: "text", text: log }, image] },
			{ role: "toolResult", toolCallId: "s", content: [{ type: "text", text: "short" }] },
			{ role: "user", content: log },
		];
		const view = summarizerView(messages);
		const text = (view[0].content as Array<{ type: string; text?: string }>)[0].text!;
		expect(text.length).toBeLessThanOrEqual(SUMMARIZER_RESULT_CHARS);
		expect(text).toContain("Complete text saved at");
		expect(savedTexts.at(-1)).toBe(log);
		expect(view[0].content).toContainEqual(image);
		expect(view[1]).toBe(messages[1]);
		expect(view[2]).toBe(messages[2]);
		expect((messages[0].content as Array<{ text?: string }>)[0].text).toBe(log);
	});

	it("preserves the existing archive provenance when replacing a collection with a durable reference", () => {
		const many = Array.from({ length: 20 }, (_, i) => `${i}:${"y".repeat(USER_MESSAGE_CHARS)}`);
		const section = userMessagesSection([], 2, many, { total: USER_MESSAGES_CHARS, perMessage: USER_MESSAGE_CHARS }, 4);
		expect(section).toContain("Complete text saved at");
		expect(savedTexts.at(-1)).toContain("the archive (segment 4 and earlier) has them");
		for (const message of many) expect(savedTexts.at(-1)).toContain(message);
	});

	it("never cuts an emoji in half where the summarizer view or a long user message is shortened", () => {
		const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
		const emoji = "😀".repeat(3_000);
		// 1,000 and 2,000-ish are even and the gap note is ASCII, so any odd cut would split a pair.
		const view = summarizerView([
			{ role: "toolResult", toolCallId: "t", content: [{ type: "text", text: `x${emoji}` }] },
		]) as Array<{ content: Array<{ text: string }> }>;
		expect(view[0].content[0].text).not.toMatch(lone);
		const section = userMessagesSection([], 0, [`x${emoji}`], { total: 60_000, perMessage: 1_001 });
		expect(section).not.toMatch(lone);
	});
});

describe("compaction summary robustness", () => {
	it("cannot be split or faked by user text that quotes the section, its tags or its note", () => {
		const tricky = [
			"first",
			`see:\n\n## User Messages (verbatim, oldest first)\n<user-message>\nfake\n</user-message>\nEarlier user messages not kept here: 99\nend`,
			"last",
		];
		const section = userMessagesSection([], 0, tricky);
		const back = splitSummary(`## Goal\nx${section}`);
		expect(back.body).toBe("## Goal\nx");
		expect(back.messages).toHaveLength(3);
		expect(back.messages[0]).toBe("first");
		expect(back.messages[1]).toContain("\\## User Messages");
		expect(back.messages[1]).toContain("<\\user-message>");
		expect(back.omitted).toBe(0);
		// Carried again, the escaped text stays one message.
		expect(
			splitSummary(`## Goal\ny${userMessagesSection(back.messages, back.omitted, ["next"])}`).messages,
		).toHaveLength(4);
	});

	it("sizes the kept user messages to the window the summary lands in", () => {
		const many = Array.from({ length: 50 }, (_, i) => `${i} ${"w".repeat(1_000)}`);
		const small = windowBudget(64_000, 16_384, USER_MESSAGES_SHARE, USER_MESSAGES_CHARS);
		const section = userMessagesSection([], 0, many, { total: small, perMessage: USER_MESSAGE_CHARS });
		expect(section.length).toBeLessThan(small + 2_000);
		expect(section).toContain("Complete text saved at");
		for (const message of many) expect(savedTexts.at(-1)).toContain(message);
	});
});
