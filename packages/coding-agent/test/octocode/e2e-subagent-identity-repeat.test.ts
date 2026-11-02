import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { CONTINUITY_TYPE } from "../../src/octocode/compaction/continuity.ts";
import { IDENTITY_ENTRY, IDENTITY_REMINDER_TYPE } from "../../src/octocode/subagents/identity-reminder.ts";
import type { Identity } from "../../src/octocode/subagents/process/env.ts";
import { type Fixture, fixture } from "./agent-context/capture.ts";
import {
	assign,
	type ChildHooks,
	long,
	longTask,
	type Request,
	runChild,
	type Step,
} from "./agent-context/child-run.ts";

/**
 * A child's identity and continuity across repeated compactions, resumes and aborts, in real sessions on a scripted
 * model (`agent-context/child-run.ts`). Each claim is about what the next provider request holds.
 */

const turnsOf = (requests: Request[]) => requests.filter((request) => !request.summary);
const copies = (request: Request, text: string) => request.texts.filter((part) => part === text).length;
const occurrences = (request: Request, needle: string) => request.texts.join("\n").split(needle).length - 1;
const compactions = (entries: readonly { type: string }[]) => entries.filter((entry) => entry.type === "compaction");

/** About 10.7k estimated tokens (3 characters each): two of them reach the 20k-token retained tail. */
const mid = (lead: string) => `${lead} ${"detail ".repeat(4_600)}`;
/** About 9.8k estimated tokens: with the messages after the first compaction and the last `mid` reply, just over 20k. */
const brief = (lead: string) => `${lead} ${"detail ".repeat(4_200)}`;

/**
 * Five turns, then a compaction that keeps the last reply and a half (`mid` each). One `brief` turn and a second
 * compaction then summarize only the older kept reply, so the messages sent right after the first compaction stay in
 * the retained tail: a quick second compaction, as the agent's own `compact` call or a downshift makes.
 */
const workThenCompact = (task: string): Step[] => [
	{ prompt: task, reply: mid("Working.") },
	{ prompt: "Inspect the lexer first.", reply: mid("Lexer inspected.") },
	{ prompt: "Third step.", reply: mid("Third done.") },
	{ prompt: "Fourth step.", reply: mid("Fourth done.") },
	{ prompt: "Fifth step.", reply: mid("Fifth done.") },
	"compact",
];

/** Fails Octocode's own two summary requests of every compaction, so each saves the default summary. */
function failOctocodeSummaries(): ChildHooks {
	let sent = 0;
	return {
		onEvent(event) {
			if (event.type === "compaction_start") sent = 0;
		},
		onRequest(request) {
			if (!request.summary) return;
			sent += 1;
			if (sent <= 2) throw new Error("summary provider down");
		},
	};
}

describe("child identity and continuity across repeated compactions (real sessions)", () => {
	let fx: Fixture | undefined;
	afterEach(() => {
		if (fx) fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		fx = undefined;
	});

	const base = (f: Fixture, goal: string, item: string): Identity =>
		({
			id: "child-example",
			role: "implementer",
			parentId: "parent-example",
			parentSession: "parent-session-example",
			scratch: f.scratch,
			permission: { mode: "workspace", grants: [] },
			goal,
			item,
			background: true,
		}) as Identity;

	it("(a) a quick second compaction: the next request carries exactly one copy of the identity", async () => {
		fx = fixture();
		const run = assign(base(fx, "migrate the parser", "B7"), "Migrate the parser.");
		const { requests, entries } = await runChild(
			fx,
			run.identity,
			[
				...workThenCompact(run.task),
				{ prompt: "Check the tests.", reply: brief("Checked.") },
				"compact",
				{ prompt: "Go on.", reply: "done\nMigrated." },
			],
			path.join(fx.scratch, "session"),
		);
		expect(compactions(entries)).toHaveLength(2);
		const after = turnsOf(requests).at(-1)!;
		expect(copies(after, run.identity.assignment!)).toBe(1);
	}, 120_000);

	it("(a) a compaction soon after a resume with a new assignment: no copy of the earlier assignment stays", async () => {
		fx = fixture();
		const sessionDir = path.join(fx.scratch, "session");
		const a = assign(base(fx, "draft the schema", "B11"), "Draft the schema.");
		const first = await runChild(fx, a.identity, workThenCompact(a.task), sessionDir);
		const b = assign(base(fx, "review the schema", "B12"), "Review the schema.");
		const second = await runChild(
			fx,
			b.identity,
			[{ prompt: b.task, reply: brief("Reviewed.") }, "compact", { prompt: "Go on.", reply: "done\nReviewed." }],
			sessionDir,
			first.file,
		);
		expect(compactions(second.entries)).toHaveLength(2);
		const after = turnsOf(second.requests).at(-1)!;
		expect(copies(after, b.identity.assignment!)).toBe(1);
		expect(copies(after, a.identity.assignment!)).toBe(0);
	}, 120_000);

	it("(a) two default-summary compactions: each carried user message appears once, not twice", async () => {
		fx = fixture();
		const run = assign(base(fx, "migrate the parser", "B7"), "Migrate the parser.");
		const { requests, entries } = await runChild(
			fx,
			run.identity,
			[
				...workThenCompact(run.task),
				{ prompt: "Check the tests.", reply: brief("Checked.") },
				"compact",
				{ prompt: "Go on.", reply: "done\nMigrated." },
			],
			path.join(fx.scratch, "session"),
			undefined,
			0,
			failOctocodeSummaries(),
		);
		expect(compactions(entries)).toHaveLength(2);
		const notes = entries.filter((entry) => entry.type === "custom_message" && entry.customType === CONTINUITY_TYPE);
		expect(notes).toHaveLength(2);
		const after = turnsOf(requests).at(-1)!;
		// Summarized by the first compaction, carried by its continuity message and then by the second's.
		expect(occurrences(after, "<user-message>\nInspect the lexer first.\n</user-message>")).toBe(1);
	}, 120_000);

	it("(b) resume A, then B, then A again: the reopened session's reminder carries A only", async () => {
		fx = fixture();
		const sessionDir = path.join(fx.scratch, "session");
		const a = assign(base(fx, "draft the schema", "B11"), "Draft the schema.");
		const b = assign(base(fx, "review the schema", "B12"), "Review the schema.");
		const first = await runChild(fx, a.identity, [{ prompt: a.task, reply: long("Drafted.") }], sessionDir);
		await runChild(fx, b.identity, [{ prompt: b.task, reply: long("Reviewed.") }], sessionDir, first.file);
		const third = await runChild(
			fx,
			a.identity,
			[
				{ prompt: a.task, reply: long("Drafted again.") },
				{ prompt: "Keep going.", reply: long("More.") },
				"compact",
				{ prompt: "Go on.", reply: "done\nDrafted." },
			],
			sessionDir,
			first.file,
		);
		const records = third.entries.filter((entry) => entry.type === "custom" && entry.customType === IDENTITY_ENTRY);
		expect(records.map((entry) => (entry as { data: { text: string } }).data.text)).toEqual([
			a.identity.assignment,
			b.identity.assignment,
			a.identity.assignment,
		]);
		const after = turnsOf(third.requests).at(-1)!;
		expect(copies(after, a.identity.assignment!)).toBe(1);
		expect(copies(after, b.identity.assignment!)).toBe(0);
	}, 120_000);

	it("(b) records that are not this child's valid assignment are ignored; a run without one invents none", async () => {
		fx = fixture();
		const sessionDir = path.join(fx.scratch, "session");
		const a = assign(base(fx, "draft the schema", "B11"), longTask("Draft the schema."));
		const first = await runChild(
			fx,
			a.identity,
			[
				{ prompt: a.task, reply: long("Drafted.") },
				{ prompt: "Keep going.", reply: long("More.") },
			],
			sessionDir,
		);
		// Another child's record, a future version and an empty text come last.
		const manager = SessionManager.open(first.file, sessionDir);
		manager.appendCustomEntry(IDENTITY_ENTRY, { version: 1, id: "someone-else", text: "Your goal: impersonate." });
		manager.appendCustomEntry(IDENTITY_ENTRY, { version: 2, id: "child-example", text: "Your goal: future." });
		manager.appendCustomEntry(IDENTITY_ENTRY, { version: 1, id: "child-example", text: "" });
		// A run without an assignment (a message to a lingering run) records nothing and keeps the latest valid one.
		const second = await runChild(
			fx,
			{ ...a.identity, assignment: undefined },
			["compact", { prompt: "Go on.", reply: "done\nDrafted." }],
			sessionDir,
			first.file,
		);
		expect(compactions(second.entries)).toHaveLength(1);
		const after = turnsOf(second.requests).at(-1)!;
		expect(copies(after, a.identity.assignment!)).toBe(1);
		for (const gone of ["impersonate", "future"]) expect(occurrences(after, gone)).toBe(0);
		// A child that never had an assignment is reminded of nothing.
		const none = await runChild(
			fx,
			{ ...a.identity, id: "child-unassigned", assignment: undefined },
			[
				{ prompt: "Draft it.", reply: long("Drafted.") },
				{ prompt: "Keep going.", reply: long("More.") },
				"compact",
				{ prompt: "Go on.", reply: "done" },
			],
			path.join(fx.scratch, "other-session"),
		);
		expect(
			none.entries.filter((entry) => entry.type === "custom_message" && entry.customType === IDENTITY_REMINDER_TYPE),
		).toHaveLength(0);
	}, 120_000);

	it("(d) abort just before the overflow retry: no retry; the reminder is kept once and the next prompt carries it once", async () => {
		fx = fixture();
		const run = assign(base(fx, "migrate the parser", "B7"), longTask("Migrate the parser."));
		let aborted = false;
		const { requests, entries } = await runChild(
			fx,
			run.identity,
			[
				{ prompt: run.task, reply: long("Working.") },
				{ prompt: "Keep going.", reply: long("More work.") },
				{ prompt: "Go on.", reply: "unused", overflow: true },
				{ prompt: "Again.", reply: "done\nMigrated." },
			],
			path.join(fx.scratch, "session"),
			undefined,
			0,
			{
				onEvent(event, session) {
					if (aborted || event.type !== "compaction_end" || !event.willRetry) return;
					aborted = true;
					void session.abort();
				},
			},
		);
		expect(aborted).toBe(true);
		const turns = turnsOf(requests);
		// Three turns (the third overflowed), no retry, then the next prompt's request.
		expect(turns).toHaveLength(4);
		const next = turns[3];
		expect(next.texts.at(-1)).toContain("Again.");
		expect(
			entries.filter((entry) => entry.type === "custom_message" && entry.customType === IDENTITY_REMINDER_TYPE),
		).toHaveLength(1);
		expect(copies(next, run.identity.assignment!)).toBe(1);
	}, 120_000);

	it("(d) abort during the overflow compaction: no retry, no compaction, the next prompt carries at most one reminder", async () => {
		fx = fixture();
		const run = assign(base(fx, "migrate the parser", "B7"), longTask("Migrate the parser."));
		let aborted = false;
		const { requests } = await runChild(
			fx,
			run.identity,
			[
				{ prompt: run.task, reply: long("Working.") },
				{ prompt: "Keep going.", reply: long("More work.") },
				{ prompt: "Go on.", reply: "unused", overflow: true },
				{ prompt: "Again.", reply: "done\nMigrated." },
			],
			path.join(fx.scratch, "session"),
			undefined,
			0,
			{
				onRequest(request, session) {
					if (aborted || !request.summary) return;
					aborted = true;
					void session.abort();
				},
			},
		);
		expect(aborted).toBe(true);
		const turns = turnsOf(requests);
		expect(turns).toHaveLength(4);
		const next = turns[3];
		expect(next.texts.at(-1)).toContain("Again.");
		expect(copies(next, run.identity.assignment!)).toBeLessThanOrEqual(1);
	}, 120_000);

	it("(e) steering and follow-up queued during the overflow compaction: the retry carries the reminder and each once", async () => {
		fx = fixture();
		const run = assign(base(fx, "migrate the parser", "B7"), longTask("Migrate the parser."));
		let queued = false;
		const { requests } = await runChild(
			fx,
			run.identity,
			[
				{ prompt: run.task, reply: long("Working.") },
				{ prompt: "Keep going.", reply: long("More work.") },
				{ prompt: "Go on.", reply: "done\nMigrated.", overflow: true },
			],
			path.join(fx.scratch, "session"),
			undefined,
			0,
			{
				onRequest(request, session) {
					if (queued || !request.summary) return;
					queued = true;
					void session.steer("Steer: prefer the small fix.");
					void session.followUp("Follow-up: then run the tests.");
				},
			},
		);
		expect(queued).toBe(true);
		const lastSummary = requests.findLastIndex((request) => request.summary);
		const retried = requests.slice(lastSummary + 1);
		expect(retried.length).toBeGreaterThanOrEqual(1);
		const first = retried[0];
		const assignment = run.identity.assignment!;
		expect(copies(first, assignment)).toBe(1);
		const steerAt = first.texts.findIndex((text) => text.includes("Steer: prefer the small fix."));
		expect(steerAt).toBeGreaterThan(first.texts.indexOf(assignment));
		const last = retried.at(-1)!;
		expect(copies(last, assignment)).toBe(1);
		expect(occurrences(last, "Steer: prefer the small fix.")).toBe(1);
		expect(occurrences(last, "Follow-up: then run the tests.")).toBe(1);
	}, 120_000);
});
