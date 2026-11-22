import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { events, tickets, type AgentDb } from "../../../../db/src/api.ts";
import { openAgentDb } from "../../../src/storage/database.ts";
import { fromEventRow } from "../../../src/octocode/events/loop/rows.ts";
import { makeSource } from "../../../src/octocode/events/source.ts";
import {
	MAX_DEPTH,
	MAX_PENDING_PER_REQUESTER,
	MAX_PENDING_PER_TARGET,
	Tickets,
	type CallbackRequest,
} from "../../../src/octocode/events/tickets.ts";
import { registerFixtureWorkspace } from "../backlog-fixture.ts";
import { tmp } from "../helpers.ts";

const peer = makeSource("peer", "b", "db", "self-reported");
const resolution = { source: peer, digest: "done, see the report" };

let file: string;
let agent: AgentDb;
let clock: number;
const open = (db: AgentDb = agent) => new Tickets(db, { workspaceId: "w1", now: () => clock });
const ask = (over: Partial<CallbackRequest> = {}): CallbackRequest => ({
	requester: "a",
	target: "b",
	text: "please review",
	on: "reply",
	requestMessage: 7,
	...over,
});
const logged = (topic?: string) =>
	events.read(agent.db, { workspaceId: "w1", after: 0, ...(topic ? { topic } : {}) }).map(fromEventRow);

beforeEach(() => {
	clock = 1_000_000;
	file = path.join(tmp(), "tickets.db");
	agent = openAgentDb(file);
	registerFixtureWorkspace(agent, "w1");
});
afterEach(() => agent.close());

function opened(result: ReturnType<Tickets["request"]>) {
	if (!result.ok) throw new Error(result.line);
	return result.ticket;
}

describe("callback tickets", () => {
	it("resolves on the target's reply, once, with the resolver's source and trust", () => {
		const t = open();
		const ticket = opened(t.request(ask({ note: "remember the diff" })));
		expect(t.resolveReply(7, "c", resolution)).toEqual([]);
		expect(t.resolveReply(7, "b", resolution)).toEqual([ticket.id]);
		expect(t.resolveReply(7, "b", resolution)).toEqual([]);
		const [result, ...rest] = logged("ticket.resolved");
		expect(rest).toEqual([]);
		expect(result?.source).toEqual(peer);
		expect(result?.source.trust).toBe(peer.trust);
		expect(result?.payload).toMatchObject({
			ticket: ticket.id,
			requester: "a",
			target: "b",
			note: "remember the diff",
		});
		expect(tickets.find(agent.db, ticket.id)).toMatchObject({ state: "resolved", result_seq: result?.seq });
	});

	it("delivers at most one result when two connections race to resolve one ticket", () => {
		const second = openAgentDb(file);
		try {
			const ticket = opened(open().request(ask()));
			const won = [open().resolveReply(7, "b", resolution), open(second).resolveReply(7, "b", resolution)];
			expect(won.flat()).toEqual([ticket.id]);
			expect(logged("ticket.resolved")).toHaveLength(1);
		} finally {
			second.close();
		}
	});

	it("survives a resume: a new connection finds the pending ticket and resolves it once", () => {
		const ticket = opened(open().request(ask({ on: "done" })));
		agent.close();
		agent = openAgentDb(file);
		const resumed = open();
		expect(tickets.pendingOf(agent.db, "w1", "a")).toBe(1);
		const report = { topic: "agent.report" as const, payload: { agent: "b" }, source: peer, digest: "b reported" };
		expect(resumed.resolveEvent(report)).toEqual([ticket.id]);
		expect(resumed.resolveEvent(report)).toEqual([]);
		agent.close();
		agent = openAgentDb(file);
		expect(logged("ticket.resolved").map((e) => e.dedupeKey)).toEqual([`ticket.resolved:${ticket.id}`]);
	});

	it("resolves item.state and job.exit tickets by their filter, and agent.ended by target", () => {
		const t = open();
		const item = opened(t.request(ask({ target: "a", on: "item.state", filter: { ref: "B41", state: "done" } })));
		const job = opened(t.request(ask({ target: "a", on: "job.exit", filter: { job: "task-3" } })));
		const ended = opened(t.request(ask({ target: "b", on: "agent.ended" })));
		const system = makeSource("system", "backlog", "db", "proven");
		expect(
			t.resolveEvent({ topic: "item.state", payload: { ref: "B41", state: "ongoing" }, source: system, digest: "x" }),
		).toEqual([]);
		expect(
			t.resolveEvent({ topic: "item.state", payload: { ref: "B41", state: "done" }, source: system, digest: "x" }),
		).toEqual([item.id]);
		expect(t.resolveEvent({ topic: "job.exit", payload: { job: "task-3" }, source: system, digest: "x" })).toEqual([
			job.id,
		]);
		expect(t.resolveEvent({ topic: "agent.ended", payload: { agent: "z" }, source: system, digest: "x" })).toEqual([]);
		expect(t.resolveEvent({ topic: "agent.ended", payload: { agent: "b" }, source: system, digest: "x" })).toEqual([
			ended.id,
		]);
	});

	it("rejects an expired ticket once, and cancel drops a later match", () => {
		const t = open();
		const late = opened(t.request(ask({ deadline: clock + 100 })));
		const cancelled = opened(t.request(ask({ text: "other", on: "done" })));
		expect(t.cancel(cancelled.id, "c")).toBe(false);
		expect(t.cancel(cancelled.id, "a")).toBe(true);
		clock += 200;
		expect(t.expire()).toEqual([late.id]);
		expect(t.expire()).toEqual([]);
		expect(t.resolveReply(7, "b", resolution)).toEqual([]);
		expect(t.resolveEvent({ topic: "agent.report", payload: { agent: "b" }, source: peer, digest: "r" })).toEqual([]);
		expect(logged("ticket.rejected").map((e) => e.payload)).toMatchObject([{ ticket: late.id, reason: "timeout" }]);
		expect(logged("ticket.resolved")).toEqual([]);
	});

	it("returns the open ticket for an identical request within a minute", () => {
		const t = open();
		const first = opened(t.request(ask()));
		clock += 30_000;
		const again = t.request(ask());
		expect(again).toMatchObject({ ok: true, reused: true });
		expect(opened(again).id).toBe(first.id);
		clock += 60_000;
		expect(opened(t.request(ask())).id).not.toBe(first.id);
	});

	it("refuses past the pending limits with one line", () => {
		const t = open();
		for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i++) opened(t.request(ask({ target: `t${i}`, text: `q${i}` })));
		const byRequester = t.request(ask({ target: "extra", text: "more" }));
		expect(byRequester).toMatchObject({ ok: false, reason: "requester-limit" });
		expect(byRequester.ok ? "" : byRequester.line).not.toContain("\n");
		for (let i = 0; i < MAX_PENDING_PER_TARGET; i++)
			opened(t.request(ask({ requester: `r${i}`, target: "busy", text: `q${i}` })));
		expect(t.request(ask({ requester: "late", target: "busy", text: "more" }))).toMatchObject({
			ok: false,
			reason: "target-limit",
		});
		expect(tickets.pendingOf(agent.db, "w1", "late")).toBe(0);
		expect(t.broadcastRefusal(5)).toMatchObject({ ok: false, reason: "broadcast" });
		expect(t.broadcastRefusal(4)).toBeUndefined();
	});

	it("refuses a request that revisits an agent in its chain, or nests deeper than the limit", () => {
		const t = open();
		const ab = opened(t.request(ask({ requester: "a", target: "b" })));
		expect(t.request(ask({ requester: "b", target: "a", text: "back", causedBy: ab.id }))).toMatchObject({
			ok: false,
			reason: "loop",
		});
		expect(logged("ticket.rejected").map((e) => e.payload)).toMatchObject([
			{ requester: "b", target: "a", reason: "loop" },
		]);
		const bc = opened(t.request(ask({ requester: "b", target: "c", causedBy: ab.id })));
		const cd = opened(t.request(ask({ requester: "c", target: "d", causedBy: bc.id })));
		expect(cd.depth).toBe(MAX_DEPTH);
		expect(t.request(ask({ requester: "d", target: "e", causedBy: cd.id }))).toMatchObject({
			ok: false,
			reason: "depth",
		});
	});

	it("keeps the tickets a leaving requester asked open (a resume) and rejects those asked of a leaving target", () => {
		const t = open();
		const asked = opened(t.request(ask({ requester: "a", target: "b" })));
		const held = opened(t.request(ask({ requester: "c", target: "a", text: "x" })));
		t.leave("a");
		expect(tickets.find(agent.db, asked.id)?.state).toBe("pending");
		expect(tickets.find(agent.db, held.id)?.state).toBe("rejected");
		expect(logged("ticket.rejected").map((e) => e.payload)).toMatchObject([{ ticket: held.id, reason: "left" }]);
	});
});
