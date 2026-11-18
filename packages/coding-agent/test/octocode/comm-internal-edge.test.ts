import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import octocode from "../../src/octocode/index.ts";
import { deriveInsights } from "../../src/octocode/profiler/insights.ts";
import { allEvents } from "../../src/octocode/profiler/timeline.ts";
import { INTERNAL_MESSAGE_TYPE } from "../../src/octocode/shared/messages.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * Internal-communication edge cases (audit lane comm-internal, 2026-11-08). Each red case names the profiled session row
 * or the code path it reproduces; the fix lane (fix-comm-internal) made them green.
 */

const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: id.replace(/-[0-9a-f]{6}$/, ""),
	pid: process.pid,
	status: "working",
	joinedAt: 1_000,
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});

const repo = () => {
	const dir = tmp();
	fs.mkdirSync(path.join(dir, ".git"));
	return dir;
};

const stores: TeamStore[] = [];
const teams: Team[] = [];
afterEach(() => {
	for (const team of teams.splice(0)) team.stop();
	for (const store of stores.splice(0)) store.close();
});
const open = () => {
	const store = TeamStore.open(repo(), path.join(tmp(), "team.sqlite"));
	stores.push(store);
	return store;
};

/** Read what is pending and acknowledge it, as a recipient does once its model is called with it. */
const take = (store: TeamStore, id: string) => {
	const got = store.pending(id);
	store.ack(
		id,
		got.map((m) => m.id),
	);
	return got;
};

/** The profiler's findings for a session whose only data is the team traffic. */
const findingsOf = (store: TeamStore) => {
	const traffic = store.recent();
	const { events, messages } = allEvents({ sessionId: "s", lanes: [], traffic, now: Date.now() });
	return deriveInsights({ sessionId: "s", lanes: [], events, messages, now: Date.now() }).findings;
};

/**
 * Reproduces messages #1040 and #1044 of profiled session 01a1b9dc: the coordinator asked three children a question;
 * two answered, the third read it and ended, and its report closed the question (`closeQuestionsTo`). Rows as stored:
 * sly-starfish delivered_at set, dead_at set, then completed_at = notified_at (report).
 */
function askThreeOneEndsWithReport(store: TeamStore) {
	for (const id of ["misty-urchin", "bouncy-whale", "glowing-octopus", "sly-starfish"]) store.save(member(id));
	const ask = store.send("misty-urchin", ["bouncy-whale", "glowing-octopus", "sly-starfish"], "status in 3 lines", {
		replyRequired: true,
	}).id!;
	for (const kid of ["bouncy-whale", "glowing-octopus", "sly-starfish"]) take(store, kid);
	store.send("bouncy-whale", ["misty-urchin"], "70% done", { replyRequired: false, replyTo: ask });
	store.send("glowing-octopus", ["misty-urchin"], "90% done", { replyRequired: false, replyTo: ask });
	// sly-starfish leaves before its report is built (dead-letters the read question), then the report closes it.
	store.remove("sly-starfish");
	store.refs.closeQuestionsTo("misty-urchin", "sly-starfish");
	return ask;
}

describe("dead letters as the sender and the profiler see them", () => {
	it("does not tell the sender about a question the child's report answered (guard)", () => {
		const store = open();
		askThreeOneEndsWithReport(store);
		expect(store.deadLetters("misty-urchin")).toEqual([]);
	});

	it("shows a question every recipient read, and the last one answered with its report, as answered", () => {
		const store = open();
		const ask = askThreeOneEndsWithReport(store);
		const row = store.recent().find((message) => message.id === ask);
		// Was red: toTraffic (team/model.ts) read any dead_at as dead-lettered; closeQuestionsTo left dead_at set.
		expect(row?.state).toBe("answered");
	});

	it("raises no 'never delivered' finding for a question every recipient read", () => {
		const store = open();
		askThreeOneEndsWithReport(store);
		// Was red: profiler/insights.ts titled every dead-lettered message "was never delivered", severity high.
		expect(findingsOf(store).filter((finding) => finding.kind === "dead-letter")).toEqual([]);
	});

	it("names a read-but-unanswered question as unanswered, and only the recipient that dropped it", () => {
		const store = open();
		for (const id of ["main-aaaaaa", "kid-111111", "kid-222222"]) store.save(member(id));
		const ask = store.send("main-aaaaaa", ["kid-111111", "kid-222222"], "which files?", { replyRequired: true }).id!;
		take(store, "kid-111111");
		take(store, "kid-222222");
		store.send("kid-111111", ["main-aaaaaa"], "a.ts", { replyRequired: false, replyTo: ask });
		// kid-222222 read it and ended with no report: a real dead letter, but the message was delivered.
		store.remove("kid-222222");
		const [finding] = findingsOf(store).filter((each) => each.kind === "dead-letter");
		expect(finding).toBeDefined();
		// Was red: the title said "was never delivered" and listed both recipients.
		expect(finding.title).not.toMatch(/never delivered/);
		expect(finding.title).not.toContain("kid-111111");
	});
});

/** A parent session and one headless subagent it started (as `team-interrupt.test.ts`). */
function family() {
	const cwd = repo();
	const db = path.join(tmp(), "team.sqlite");
	const agent = (env: Record<string, string>, hasUI: boolean) => {
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: db, ...env });
		registerCollab(fake.api, team);
		const ctx = fakeCtx({ cwd, hasUI, idle: false });
		team.start(ctx);
		teams.push(team);
		return { ...fake, team, ctx };
	};
	const parent = agent({}, true);
	const parentId = parent.team.join().id;
	const child = agent({ OCTOCODE_AGENT_ID: "general-777777", OCTOCODE_PARENT_ID: parentId }, false);
	child.team.join();
	const store = TeamStore.open(cwd, db);
	stores.push(store);
	return { parent, parentId, child, store };
}

describe("dropped recipients in the feed (Traffic.dropped)", () => {
	it("names each recipient that left with the message, and whether it read it", () => {
		const store = open();
		for (const id of ["main-aaaaaa", "kid-111111", "kid-222222", "kid-333333"]) store.save(member(id));
		const ask = store.send("main-aaaaaa", ["kid-111111", "kid-222222", "kid-333333"], "which files?", {
			replyRequired: true,
		}).id!;
		take(store, "kid-111111");
		take(store, "kid-222222");
		store.send("kid-111111", ["main-aaaaaa"], "a.ts", { replyRequired: false, replyTo: ask });
		store.remove("kid-222222");
		store.remove("kid-333333");
		const row = store.recent().find((message) => message.id === ask);
		expect(row?.state).toBe("dead-lettered");
		expect(row?.dropped).toEqual([
			{ recipient: "kid-222222", read: true },
			{ recipient: "kid-333333", read: false },
		]);
		const [finding] = findingsOf(store).filter((each) => each.kind === "dead-letter");
		expect(finding.title).toContain("was not read by kid-333333");
		expect(finding.title).toContain("was read but not answered by kid-222222");
	});

	it("leaves dropped out when every recipient took the message", () => {
		const store = open();
		for (const id of ["main-aaaaaa", "kid-111111"]) store.save(member(id));
		const sent = store.send("main-aaaaaa", ["kid-111111"], "fyi", { replyRequired: false }).id!;
		take(store, "kid-111111");
		expect(store.recent().find((message) => message.id === sent)).not.toHaveProperty("dropped");
	});

	it("rates a dead letter high when no recipient read it and medium when it was read but not answered", () => {
		const store = open();
		for (const id of ["main-aaaaaa", "kid-111111", "kid-222222"]) store.save(member(id));
		const unread = store.send("main-aaaaaa", ["kid-111111"], "start on a.ts", { replyRequired: true }).id!;
		const unanswered = store.send("main-aaaaaa", ["kid-222222"], "which files?", { replyRequired: true }).id!;
		take(store, "kid-222222");
		store.remove("kid-111111");
		store.remove("kid-222222");
		const letters = findingsOf(store).filter((each) => each.kind === "dead-letter");
		expect(letters.find((each) => each.id === `dead:${unread}`)).toMatchObject({
			severity: "high",
			title: "A message from main-aaaaaa was not read by kid-111111",
		});
		expect(letters.find((each) => each.id === `dead:${unanswered}`)).toMatchObject({
			severity: "medium",
			title: "A message from main-aaaaaa was read but not answered by kid-222222",
		});
	});

	it("says a dead letter without a dropped list was never delivered, as older snapshots did", () => {
		const { events, messages } = allEvents({
			sessionId: "s",
			lanes: [],
			traffic: [{ id: 7, from: "main-aaaaaa", to: ["kid-111111"], text: "lost", at: 1, state: "dead-lettered" }],
			now: 2,
		});
		const [finding] = deriveInsights({ sessionId: "s", lanes: [], events, messages, now: 2 }).findings.filter(
			(each) => each.kind === "dead-letter",
		);
		expect(finding).toMatchObject({
			severity: "high",
			title: "A message from main-aaaaaa to kid-111111 was never delivered",
		});
	});
});

describe("a coordinator's question to a running child", () => {
	const delivered = <T extends { message: { customType?: string } }>(sent: T[]) =>
		sent.filter((entry) => entry.message.customType === INTERNAL_MESSAGE_TYPE);

	it("ends the child's end-of-run wait until the model is called with it, then the next wait holds again", async () => {
		const { parent, child } = family();
		expect(child.team.interrupted.aborted).toBe(false);
		await parent.team.send(child.team.id, "status?", { replyRequired: true });
		await vi.waitFor(() => expect(child.team.interrupted.aborted).toBe(true), { timeout: 3_000 });
		const [question] = delivered(child.sent);
		await child.emit(
			"context",
			{ messages: [{ role: "custom", customType: INTERNAL_MESSAGE_TYPE, details: question.message.details }] },
			child.ctx,
		);
		expect(child.team.interrupted.aborted).toBe(false);
	});

	it("does not end the wait for an FYI from the coordinator", async () => {
		const { parent, child } = family();
		await parent.team.send(child.team.id, "fyi: rebased", { replyRequired: false });
		await vi.waitFor(() => expect(delivered(child.sent)).toHaveLength(1), { timeout: 3_000 });
		expect(child.team.interrupted.aborted).toBe(false);
	});
});

describe("a reply whose asker ended", () => {
	it("closes the question and sends nothing, so the answerer stops owing it (guard: no other test reaches closeQuestion)", async () => {
		const cwd = repo();
		const db = path.join(tmp(), "team.sqlite");
		const session = () => {
			const fake = fakeHost();
			const team = new Team(fake.api, { OCTOCODE_AGENT_DB: db });
			registerCollab(fake.api, team);
			team.start(fakeCtx({ cwd, hasUI: true, idle: false }));
			teams.push(team);
			return team;
		};
		const asker = session();
		const answerer = session();
		const askerId = asker.join().id;
		answerer.join();
		const asked = await asker.send(answerer.id, "which branch?", { replyRequired: true });
		const question = (asked as { id: number }).id;
		const store = TeamStore.open(cwd, db);
		stores.push(store);
		take(store, answerer.id!);
		expect(store.refs.openQuestions().some((open) => open.id === question)).toBe(true);
		asker.leave();
		const result = await answerer.send(undefined, "main", { replyTo: question, replyRequired: false });
		expect((result as { error: string }).error).toContain(`question #${question} is closed`);
		expect((result as { error: string }).error).toContain(askerId);
		expect(store.refs.openQuestions().some((open) => open.id === question)).toBe(false);
	});
});

describe("a child whose coordinator ended", () => {
	it("is told its coordinator left when it sends to parent, not that no agent is called parent", async () => {
		const { parentId, child, store } = family();
		store.remove(parentId);
		const result = await child.team.send("parent", "done, see report", { replyRequired: false });
		expect(result).toHaveProperty("error");
		const error = (result as { error: string }).error;
		// Was red: resolveTarget fell through to the role lookup: `No live agent "parent". Live agents: none.`
		expect(error).toContain(parentId);
	});
});

describe("a headless child holding for its own background job", () => {
	it("stops holding for a question from its coordinator, as it does for an interrupt", async () => {
		const cwd = repo();
		const db = path.join(tmp(), "team.sqlite");
		const saved = { ...process.env };
		Object.assign(process.env, {
			OCTOCODE_HOME: tmp(),
			OCTOCODE_AGENT_DB: db,
			OCTOCODE_AGENT_ID: "general-131313",
			OCTOCODE_PARENT_ID: "main-bbbbbb",
		});
		const fake = fakeHost();
		const ctx = fakeCtx({ cwd, hasUI: false, idle: false });
		try {
			await octocode(fake.api);
			await fake.emit("session_start", { type: "session_start" }, ctx);
			await fake.tools
				.get("bash")
				.execute("t1", { command: "sleep 20", background: true, timeout: 60 }, undefined, undefined, ctx);
			const store = TeamStore.open(cwd, db);
			stores.push(store);
			store.save(member("main-bbbbbb"));
			// A question wakes (replyRequired), but it is not an interrupt: the parent wants an answer, not a cancelled job.
			store.send("main-bbbbbb", ["general-131313"], "status? reply in one line", { replyRequired: true });
			const started = Date.now();
			await fake.emit(
				"agent_before_settle",
				{
					type: "agent_before_settle",
					outcome: "completed",
					entries: [],
					context: { llmMessages: [], contextMessages: [] },
					continue: false,
				},
				ctx,
			);
			// The question reached the session (steered, waking) during the hold: delivery is not what is missing.
			expect(
				fake.sent.some((entry) => JSON.stringify(entry.message.details ?? {}).includes("status? reply in one line")),
			).toBe(true);
			// Was red: session-lifecycle.ts held until the job ended (`stop` = ctx.signal + team.interrupted only), so the
			// question waited the whole job while the sender was told "next-step".
			expect(Date.now() - started).toBeLessThan(8_000);
		} finally {
			await fake.emit("session_shutdown", { type: "session_shutdown" }, ctx);
			process.env = saved;
		}
	}, 40_000);
});

describe("reviewer follow-ups (lane c-graph)", () => {
	it("keeps a dead letter the sender was already told of when a later report closes the question", () => {
		const store = open();
		for (const id of ["main-aaaaaa", "kid-333333"]) store.save(member(id));
		const ask = store.send("main-aaaaaa", ["kid-333333"], "which files?", { replyRequired: true }).id!;
		take(store, "kid-333333");
		store.remove("kid-333333");
		// The asker hears the question went unanswered, then the child's report arrives.
		const letters = store.deadLetters("main-aaaaaa");
		expect(letters.map((letter) => letter.id)).toContain(ask);
		store.markNotified(letters);
		store.refs.closeQuestionsTo("main-aaaaaa", "kid-333333");
		const row = store.recent().find((message) => message.id === ask);
		expect(row?.state).toBe("dead-lettered");
		expect(row?.dropped).toEqual([{ recipient: "kid-333333", read: true }]);
	});

	it("leaves a failed relay request out of the recipients that dropped a message", () => {
		const store = open();
		for (const id of ["main-aaaaaa", "kid-444444"]) store.save(member(id));
		const id = store.refs.relay("kid-444444", "main-aaaaaa", "gone-555555", "please check", { replyRequired: true })!;
		store.refs.takeRelay(id, "main-aaaaaa", () =>
			store.refs.failRelay(id, "main-aaaaaa", "gone-555555", "gone-555555 has finished"),
		);
		const row = store.recent().find((message) => message.id === id);
		// The parent only carried the request: it neither read nor dropped the question.
		expect(row?.dropped ?? []).toEqual([]);
	});
});
