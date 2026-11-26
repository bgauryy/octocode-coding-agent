import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { doneRefusal } from "../../src/octocode/backlog/done-guard.ts";
import { HandedItems, servedItems } from "../../src/octocode/subagents/handed-items.ts";
import { SendReceipts } from "../../src/octocode/api/receipts.ts";
import { MemoryEventStore } from "../../src/octocode/events/loop/store.ts";
import { registerLoopGuard } from "../../src/octocode/loop-guard.ts";
import { parsePrerequisite, PrerequisiteGate } from "../../src/octocode/subagents/prerequisites.ts";
import { reportDigest } from "../../src/octocode/subagents/report-digest.ts";
import { reportOutcome, reportStatus } from "../../src/octocode/subagents/report-outcome.ts";
import { admitResultSchema, validateResultAnswer } from "../../src/octocode/subagents/result-schema.ts";
import { Delivery } from "../../src/octocode/team/delivery.ts";
import { Mail } from "../../src/octocode/team/mail.ts";
import { resolveTarget } from "../../src/octocode/team/routing.ts";
import { sendMessage, type SendHost } from "../../src/octocode/team/session/send.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { registerSendMessageTool, type PeerRoute } from "../../src/octocode/team/tools/messages.ts";
import { WakePace } from "../../src/octocode/team/wake-pace.ts";
import { INTERNAL_MESSAGE_TYPE } from "../../src/octocode/shared/messages.ts";
import { wakeGateOf } from "../../src/octocode/wake/gate.ts";
import { registerWake } from "../../src/octocode/wake/register.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

const openStores: TeamStore[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const s of openStores.splice(0)) s.close();
});

function memberRow(id: string, overrides: Partial<Member> = {}): Member {
	return {
		id,
		role: overrides.role ?? id,
		pid: overrides.pid ?? process.pid,
		status: overrides.status ?? "idle",
		joinedAt: Date.now(),
		updatedAt: Date.now(),
		toolCalls: 0,
		input: 0,
		cacheRead: 0,
		output: 0,
		cost: 0,
		unpriced: false,
		...overrides,
	};
}

function makeStore(): TeamStore {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	const store = TeamStore.open(cwd, path.join(tmp(), "team.sqlite"));
	openStores.push(store);
	return store;
}

describe("Messaging & Agentic Orchestration improvements (TDD)", () => {
	it("routes cross-process top-level session IDs and coordinator through Peers instead of bypassing permissions via Team", async () => {
		const fake = fakeHost();
		const ctx = fakeCtx({ cwd: tmp() });
		let registeredTool: any;
		const peerSend = vi.fn(async (to: string, text: string) => ({
			text: `Sent via Peers to ${to}: ${text}`,
			details: { to: [to] },
		}));
		const teamSend = vi.fn(async () => ({ sent: ["other-top"], id: 1 }));
		const peers: PeerRoute = {
			addresses: (to) => to === "other-top" || to === "coordinator",
			send: peerSend,
			list: async () => "",
		};
		const team = {
			members: () => [
				memberRow("me", { pid: process.pid }),
				// Top-level session in ANOTHER process is in team.members()!
				memberRow("other-top", { pid: process.pid + 9999, parentId: undefined }),
				// Child subagent in another process HAS parentId -> stays on TeamStore!
				memberRow("my-child", { pid: process.pid + 8888, parentId: "me" }),
				// Local teammate with role "coordinator" must NOT shadow linked-worktree `to: "coordinator"` peer route
				memberRow("local-coord", { pid: process.pid, role: "coordinator", parentId: "me" }),
			],
			patiently: async (fn: () => any) => fn(),
			join: () => memberRow("me"),
			send: teamSend,
		} as any;

		registerSendMessageTool(fake.api, team, (t) => (registeredTool = t), peers);

		await registeredTool.execute("c1", { to: "other-top", message: "hello peer" }, undefined, undefined, ctx);
		expect(peerSend).toHaveBeenCalledTimes(1);
		expect(teamSend).not.toHaveBeenCalled();

		await registeredTool.execute("c2", { to: "coordinator", message: "merge please" }, undefined, undefined, ctx);
		expect(peerSend).toHaveBeenCalledTimes(2);
	});

	it.each(["throw", "reject"] as const)(
		"propagates async WakeGate release failures to Mail onRejected so Inbox recovers instead of wedging unseen (%s)",
		async (failure) => {
			vi.useFakeTimers();
			const fake = fakeHost({ runtime: { eventWindowSeconds: 2 } });
			const ctx = fakeCtx({ cwd: tmp(), idle: true });
			const eventStore = new MemoryEventStore();
			registerWake(fake.api, { live: { store: () => eventStore } });
			await fake.emit("session_start", { reason: "startup" }, ctx);

			const store = makeStore();
			store.save(memberRow("me"));
			store.save(memberRow("peer"));
			const mail = new Mail(fake.api);
			const delivery = new Delivery(
				{
					id: () => "me",
					parentId: () => undefined,
					ctx: () => ctx,
					headless: () => false,
					heartbeat: () => false,
					relays: () => undefined,
					reporting: () => false,
					checkIn: () => ({ seconds: 0, parentWaits: false }),
				},
				mail,
				new WakePace(() => Date.now()),
			);

			// First sendMessage fails when the 2s hold window releases; second succeeds!
			const realSend = fake.api.session.sendMessage;
			let failNext = true;
			let attempts = 0;
			(fake.api.session as any).sendMessage = (msg: any, opts: any) => {
				attempts++;
				if (failNext) {
					failNext = false;
					if (failure === "throw") throw new Error("transient send failure");
					return Promise.reject(new Error("transient send failure"));
				}
				return realSend(msg, opts);
			};

			const written = store.send("peer", ["me"], "important message", { replyRequired: true, wake: true });
			expect(written.id).toBeDefined();

			delivery.deliver(store);
			expect(fake.sent).toHaveLength(0);

			// Advance past 2s window: sendRouted throws -> detaches broken loop AND must invoke Mail's onRejected!
			await vi.advanceTimersByTimeAsync(2_000);
			expect(failNext).toBe(false);

			// Next tick must retry and deliver the message instead of wedging Inbox.unseen forever!
			await vi.advanceTimersByTimeAsync(31_000);
			delivery.deliver(store);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(attempts).toBe(2);
			expect(fake.sent).toHaveLength(1);
			expect(String(fake.sent[0].message.content)).toContain("important message");
			expect(wakeGateOf(fake.api)).toBeDefined();
		},
	);

	it("exempts child replyRequired questions from WakePace and isolates per-sender peer pacing", () => {
		const store = makeStore();
		store.save(memberRow("me"));
		store.save(memberRow("peer-1"));
		store.save(memberRow("peer-2"));
		store.save(memberRow("child-1", { parentId: "me" }));

		let now = 100_000;
		const batches: any[][] = [];
		const handed: string[][] = [];
		const delivery = new Delivery(
			{
				id: () => "me",
				parentId: () => undefined,
				ctx: () => ({ isIdle: () => true, hasUI: false }) as never,
				headless: () => false,
				heartbeat: () => false,
				relays: () => undefined,
				reporting: () => false,
				checkIn: () => ({ seconds: 0, parentWaits: false }),
			},
			{
				settled: () => false,
				notice: () => true,
				forgetForUser: () => undefined,
				modelCalled: () => undefined,
				reportDeadLetters: () => undefined,
				pruneForUser: () => undefined,
				deliver: (batch: any[]) => {
					batches.push(batch);
					handed.push(batch.map((m) => m.text));
					return true;
				},
			} as any,
			new WakePace(() => now),
		);
		const markSeen = () =>
			delivery.seen(store, [
				{ role: "custom", customType: INTERNAL_MESSAGE_TYPE, details: { messages: batches.flat() } },
			]);

		// peer-1 wakes me with an FYI:
		store.send("peer-1", ["me"], "peer-1 fyi", { replyRequired: false, wake: true });
		delivery.deliver(store);
		markSeen();
		expect(handed).toEqual([["peer-1 fyi"]]);

		// 1 second later, child-1 asks a blocking replyRequired question -> MUST NOT be held back by peer-1's pace!
		now += 1_000;
		store.send("child-1", ["me"], "child blocker?", { replyRequired: true, wake: true });
		delivery.deliver(store);
		markSeen();
		expect(handed).toEqual([["peer-1 fyi"], ["child blocker?"]]);

		// Exhaust peer-1's 6-wake window (5 more wakes spaced by 30s):
		for (let i = 2; i <= 6; i++) {
			now += 30_000;
			store.send("peer-1", ["me"], `peer-1 #${i}`, { replyRequired: false, wake: true });
			delivery.deliver(store);
			markSeen();
		}
		expect(handed).toHaveLength(7);

		// 30s later, peer-1 is over its per-sender window cap, so peer-1 alone is held:
		now += 30_000;
		store.send("peer-1", ["me"], "peer-1 over-cap", { replyRequired: false, wake: true });
		delivery.deliver(store);
		expect(handed).toHaveLength(7);

		// Independent peer-2 has fresh per-sender budget and is NOT starved for 7 minutes by peer-1!
		store.send("peer-2", ["me"], "peer-2 first", { replyRequired: false, wake: true });
		delivery.deliver(store);
		expect(handed.at(-1)).toEqual(["peer-1 over-cap", "peer-2 first"]);
	});

	it("auto-binds replyTo for a single open delivered question, normalizes recipient whitespace/case, and names only matching role holders", async () => {
		const store = makeStore();
		const me = memberRow("worker", { parentId: "coord", role: "implementer" });
		const coord = memberRow("coord", { role: "lead" });
		const rev1 = memberRow("rev-1", { parentId: "coord", role: "reviewer" });
		const rev2 = memberRow("rev-2", { parentId: "coord", role: "reviewer" });
		const unrelated = memberRow("doc-1", { parentId: "coord", role: "writer" });
		for (const m of [me, coord, rev1, rev2, unrelated]) store.save(m);

		// Role ambiguity lists ONLY the matching role holders (rev-1, rev-2), not doc-1 or coord!
		const ambiguous = resolveTarget([me, coord, rev1, rev2, unrelated], "worker", "reviewer", "coord");
		expect(ambiguous).toBe('"reviewer" matches several agents (rev-1, rev-2); use one id.');

		// Case-insensitive + whitespace-trimmed " PARENT " resolves to coord!
		const stableCtx = fakeCtx({ cwd: tmp() });
		const host: SendHost = {
			me: () => me,
			ctx: () => stableCtx,
			db: () => store,
			store: () => store,
			parentId: () => "coord",
			finished: new Map(),
			reporting: () => false,
			resumer: () => undefined,
			messageHook: () => undefined,
			signed: () => undefined,
			signedByParent: () => undefined,
			mail: { createdForUser: () => undefined },
		};

		// Coord asks worker a replyRequired question and worker reads it:
		const ask = store.send("coord", ["worker"], "Which migration file?", { replyRequired: true, wake: true });
		store.ack("worker", [ask.id!]);
		expect(store.refs.openQuestions()).toHaveLength(1);

		// Worker replies to " PARENT " WITHOUT specifying replyTo -> auto-binds to the single open question from coord!
		const res = await sendMessage(host, " PARENT ", "004_init.sql");
		expect("sent" in res && res.sent).toEqual(["coord"]);
		expect(store.refs.openQuestions()).toHaveLength(0);
	});

	it("evicts cancelled never-sent receipts in SendReceipts at capacity while retaining settled idempotency receipts", () => {
		const receipts = new SendReceipts();
		receipts.follow("session-1");

		// First slot is cancelled before dispatch (nothing sent); remaining 127 are settled (dispatched idempotency keys).
		const { receipt: first } = receipts.open("fp-0", { id: "m-0", queued: "turn" }, "k-0", false);
		receipts.cancelPreparation(first, "cancelled");
		for (let i = 1; i < 128; i++) {
			const key = `k-${i}`;
			const { receipt, waiter } = receipts.open(`fp-${i}`, { id: `m-${i}`, queued: "turn" }, key, false);
			receipts.accept(receipt, waiter, false, "turn", key);
		}
		receipts.settle({ text: "done", stopReason: "stop" });

		// 129th keyed send reclaims the cancelled slot instead of wedging capacity, while retaining all 127 settled keys!
		expect(() => receipts.assertRoom("k-128")).not.toThrow();
		expect(receipts.get("k-0")).toBeUndefined();
		expect(receipts.get("k-1")?.phase).toBe("settled");
	});

	it("protects PrerequisiteGate against child off-before-noteEnd race and parses item:B12 / #B12", async () => {
		expect(parsePrerequisite("item:B12")).toEqual({ kind: "item", ref: "B12" });
		expect(parsePrerequisite("#b12")).toEqual({ kind: "item", ref: "B12" });

		let lifecycleListener: ((notice: any) => void) | undefined;
		let parentStillFinalizing = true;
		const gate = new PrerequisiteGate({
			item: () => "open",
			ownRunning: (id) => id === "child-a" && parentStillFinalizing,
			lifecycle: (fn) => {
				lifecycleListener = fn;
				return () => {
					lifecycleListener = undefined;
				};
			},
			follow: () => () => undefined,
		});

		const waiting = gate.wait([{ kind: "agent", id: "child-a" }], new AbortController().signal);
		// Child process retires its row (`off` with no outcome) BEFORE parent finishes reading report & calling noteEnd!
		lifecycleListener?.({ kind: "off", agent: "child-a", reason: "completed", data: {}, seq: 7 });

		parentStillFinalizing = false;
		gate.noteEnd("child-a", { reason: "completed", outcome: "done" });

		await expect(waiting).resolves.toEqual({ status: "met" });
	});

	it("preserves trailing Noticed / For coordinator / Ask user lines in reportDigest and handles markdown/prose outcomes & structured results", () => {
		const body = [
			"done: migrated all 14 query modules.",
			"Detailed notes line ".repeat(140),
			"For coordinator: run full e2e after merging B14.",
			"Noticed: read tool retried once on symlink path.",
			"Ask user: confirm production retention window.",
			"Full report: /tmp/report.md",
		].join("\n");

		const digest = reportDigest(body, "/tmp/report.md");
		expect(digest.length).toBeLessThanOrEqual(2_100);
		expect(digest).toContain("For coordinator: run full e2e after merging B14.");
		expect(digest).toContain("Noticed: read tool retried once on symlink path.");
		expect(digest).toContain("Ask user: confirm production retention window.");
		expect(digest).toContain("Full report: /tmp/report.md");

		// Flexible markdown headings / bullets / blockquotes & prose mentioning fixed failures:
		expect(reportStatus("## Done: fixed partial reads")).toBe("done");
		expect(reportStatus("- **Blocked**: waiting on API token")).toBe("blocked");
		expect(reportStatus("> failed: unit tests red")).toBe("failed");
		expect(reportStatus("Done fixing failed login and partial read handling")).toBe("done");
		expect(reportStatus("**Done** with the audit, but blocked by missing fixture")).toBeUndefined();
		// Existing negative invariants MUST stay undefined:
		expect(reportOutcome("## Outcome\nIt went well.")).toBeUndefined();
		expect(reportStatus("1. done")).toBeUndefined();
		expect(reportStatus("Done with the audit, but blocked by missing fixture")).toBeUndefined();

		// Flexible Structured result marker formatting:
		const contract = admitResultSchema({
			type: "object",
			properties: { verdict: { type: "string" } },
			required: ["verdict"],
		});
		expect(
			validateResultAnswer('done\n\n**Structured result:**\n\n```json\n{"verdict":"ship"}\n```\n', contract),
		).toMatchObject({ status: "valid", data: { verdict: "ship" } });
		expect(
			validateResultAnswer(
				'done\n**Structured result:**\n```json\n{"verdict":"a"}\n```\nStructured result:\n```json\n{"verdict":"b"}\n```',
				contract,
			).status,
		).toBe("invalid");
	});

	it("emits loopNote on the 3rd identical read even with unchangedOf dedupe and keeps failing streaks across exempt calls", async () => {
		const fake = fakeHost();
		const ctx = fakeCtx({ cwd: tmp() });
		registerLoopGuard(fake.api);
		await fake.emit("session_start", { reason: "startup" }, ctx);

		const runRead = async (id: string, deduped: boolean) => {
			await fake.emit(
				"tool_execution_start",
				{ toolCallId: id, toolName: "read", args: { path: "src/a.ts", reason: `try-${id}` } },
				ctx,
			);
			if (!deduped) {
				await fake.emit(
					"tool_result",
					{
						toolCallId: id,
						toolName: "read",
						isError: false,
						content: [{ type: "text", text: "const a = 1;" }],
					},
					ctx,
				);
			} else {
				await fake.emit(
					"tool_result",
					{
						toolCallId: id,
						toolName: "read",
						isError: false,
						details: { unchangedOf: "r1" },
						content: [{ type: "text", text: "[Unchanged since earlier read]" }],
					},
					ctx,
				);
			}
			return fake.emit(
				"message_end",
				{
					message: {
						role: "toolResult",
						toolCallId: id,
						toolName: "read",
						isError: false,
						details: deduped ? { unchangedOf: "r1" } : {},
						content: [{ type: "text", text: deduped ? "[Unchanged since earlier read]" : "const a = 1;" }],
					},
				},
				ctx,
			);
		};

		await runRead("r1", false);
		await runRead("r2", true);
		const third = await runRead("r3", true);
		expect(JSON.stringify(third)).toContain("3 times in a row");

		// Interleaved exempt `backlog` call must NOT reset a failing `file` loop streak!
		await fake.emit("before_agent_start", {}, ctx);
		for (let i = 1; i <= 2; i++) {
			const id = `f${i}`;
			await fake.emit("tool_execution_start", { toolCallId: id, toolName: "file", args: { path: "x.ts" } }, ctx);
			await fake.emit(
				"message_end",
				{
					message: {
						role: "toolResult",
						toolCallId: id,
						toolName: "file",
						isError: true,
						content: [{ type: "text", text: `err ${i}` }],
					},
				},
				ctx,
			);
		}
		// Exempt call in between:
		await fake.emit("tool_execution_start", { toolCallId: "b1", toolName: "backlog", args: { op: "list" } }, ctx);
		await fake.emit(
			"message_end",
			{
				message: {
					role: "toolResult",
					toolCallId: "b1",
					toolName: "backlog",
					isError: false,
					content: [{ type: "text", text: "items" }],
				},
			},
			ctx,
		);
		// 3rd failing `file` call MUST hit count === 3 and emit loopNote!
		await fake.emit("tool_execution_start", { toolCallId: "f3", toolName: "file", args: { path: "x.ts" } }, ctx);
		const thirdFail = await fake.emit(
			"message_end",
			{
				message: {
					role: "toolResult",
					toolCallId: "f3",
					toolName: "file",
					isError: true,
					content: [{ type: "text", text: "err 3" }],
				},
			},
			ctx,
		);
		expect(JSON.stringify(thirdFail)).toContain("3 times in a row");
	});

	it("blocks backlog done when a running child holds multiple items via hand and skips running worktrees", () => {
		const cwd = tmp();
		const backlog = openBacklog(fakeCtx({ cwd }), { isSubagent: false });
		const b1 = backlog.store.add({ title: "first", goal: "g", why: "w", state: "todo", createdBy: "user" });
		const b2 = backlog.store.add({ title: "handed", goal: "g", why: "w", state: "todo", createdBy: "user" });

		const handed = new HandedItems();
		handed.add("worker-1", b2.ref, () => {});
		const runs = {
			running: new Map([["worker-1", undefined]]),
			items: new Map([["worker-1", b1.ref]]),
			handed,
		};

		// Map(servedItems(runs)) previously overwrote worker-1 -> b1 with b2, losing b1!
		const refusalOnFirst = doneRefusal(
			backlog.store,
			b1,
			{
				children: () => [...servedItems(runs)],
				work: () => [],
				locks: () => [],
				worktrees: () => ["worker-1"],
			},
			cwd,
		);
		expect(refusalOnFirst).toContain(`child worker-1 works on ${b1.ref}`);
		expect(refusalOnFirst).not.toContain("worktree worker-1");
	});
});
