import { afterEach, describe, expect, it, vi } from "vitest";
import { Tickets } from "../../../src/octocode/events/tickets.ts";
import { makeSource } from "../../../src/octocode/events/source.ts";
import { sharedAgentDb } from "../../../src/storage/database.ts";
import { registeredWorkspace } from "../../../src/storage/workspace-database.ts";
import { branchLines, count, createRig, type Rig } from "./rig.ts";

/**
 * A callback ticket's result reaches the asker's session as an event: through the wake gate in the old mode and through the
 * live loop in `new` (`OCTOCODE_TEST_EVENT_LOOP`), once, and a result that came while the session was away is delivered
 * when it starts.
 */

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
});

const peer = makeSource("peer", "worker", "db", "self-reported");

async function asker() {
	const rig = await createRig();
	rigs.push(rig);
	const agent = sharedAgentDb();
	const tickets = new Tickets(agent, {
		workspaceId: registeredWorkspace(rig.ctx.cwd, agent).id,
		sessionId: rig.ctx.sessionManager.getSessionId(),
	});
	return { rig, tickets };
}

const request = (text: string, over: { on?: "done" | "reply"; deadline?: number } = {}) => ({
	requester: "asker",
	target: "worker",
	text,
	on: over.on ?? ("done" as const),
	...(over.deadline ? { deadline: over.deadline } : {}),
});

describe("ticket results", () => {
	it("wakes the asker with the resolving event's digest, once", async () => {
		const { rig, tickets } = await asker();
		rig.harness.setResponses([rig.reply("noted")]);
		const opened = tickets.request(request("ship the fix"));
		expect(opened.ok).toBe(true);
		const report = {
			topic: "agent.report" as const,
			payload: { agent: "worker" },
			source: peer,
			digest: "worker finished the fix",
		};
		expect(tickets.resolveEvent(report)).toHaveLength(1);
		expect(tickets.resolveEvent(report)).toEqual([]);
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		expect(count(rig.requests[0] ?? [], "worker finished the fix")).toBe(1);
		expect(count(branchLines(rig.harness), "worker finished the fix")).toBe(1);
	});

	it("wakes the asker when a ticket expires", async () => {
		const { rig, tickets } = await asker();
		rig.harness.setResponses([rig.reply("noted")]);
		tickets.request(request("ship the fix", { deadline: Date.now() + 1 }));
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
		expect(count(rig.requests[0] ?? [], "timeout")).toBeGreaterThan(0);
	});
});
