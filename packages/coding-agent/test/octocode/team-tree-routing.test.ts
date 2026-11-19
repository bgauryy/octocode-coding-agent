// A subagent messages only its own session tree (its parent relays beyond it), a parent holds a stand-up with one
// broadcast whose replies come back to it, and `coordinate list` shows each agent's item, why and log folders.
import fs from "node:fs";
import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { afterEach, describe, expect, it } from "vitest";
import { agentRuns, backlog, sessions, sharedDatabase } from "../../../db/src/api.ts";
import { describeMembers } from "../../src/octocode/team/member-list.ts";
import { interruptRefusal, resolveTarget } from "../../src/octocode/team/routing.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const member = (id: string, role: string, parentId?: string): Member => ({
	id,
	role,
	...(parentId ? { parentId } : {}),
	pid: process.pid,
	status: "idle",
	joinedAt: 0,
	updatedAt: 0,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});

// Two trees: main-a (kids a1, a2; a1's child a1x) and main-b (kid b1, a reviewer).
const members = [
	member("main-a", "main"),
	member("kid-a1", "general", "main-a"),
	member("kid-a2", "implementer", "main-a"),
	member("kid-a1x", "researcher", "kid-a1"),
	member("main-b", "main"),
	member("kid-b1", "reviewer", "main-b"),
];
const ids = (result: Member[] | string) => (typeof result === "string" ? result : result.map((each) => each.id));

describe("interruptRefusal", () => {
	const kids = (...who: string[]) => members.filter((each) => who.includes(each.id));

	it("lets a parent interrupt several of its own subagents with one broadcast", () => {
		expect(interruptRefusal(members, kids("kid-a1", "kid-a2"), "main-a", "all", "main-a")).toBeUndefined();
	});

	it("refuses the whole broadcast when one target is not the sender's subagent, naming it", () => {
		expect(interruptRefusal(members, kids("kid-a1", "kid-a1x"), "main-a", "all", "main-a")).toMatch(
			/stops only subagents you started; kid-a1x is not one.*Nothing was sent/,
		);
	});

	it("lets the user interrupt every subagent of this session and refuses another session's", () => {
		expect(interruptRefusal(members, kids("kid-a1", "kid-a1x"), "user", "all", "main-a")).toBeUndefined();
		expect(interruptRefusal(members, kids("kid-a1", "kid-b1"), "user", "all", "main-a")).toMatch(/kid-b1 is not one/);
		expect(interruptRefusal(members, kids("main-a"), "user", "main-a", "main-a")).toMatch(/main-a is not one/);
	});

	it("refuses an interrupt with no recipient", () => {
		expect(interruptRefusal(members, [], "main-a", "all", "main-a")).toMatch(/needs a recipient/);
	});
});

describe("resolveTarget for a subagent sender", () => {
	it("refuses an agent of another tree, by id or role, naming its parent as the route", () => {
		expect(resolveTarget(members, "kid-a1", "kid-b1", "main-a")).toBe(
			"kid-b1 is outside your team; ask your coordinator (main-a) to relay.",
		);
		expect(resolveTarget(members, "kid-a1", "main-b", "main-a")).toMatch(/^main-b is outside your team/);
		expect(resolveTarget(members, "kid-a1", "reviewer", "main-a")).toMatch(/^Every "reviewer" is outside your team/);
	});

	it("reaches its parent, siblings and the rest of its tree", () => {
		expect(ids(resolveTarget(members, "kid-a1", "parent", "main-a"))).toEqual(["main-a"]);
		expect(ids(resolveTarget(members, "kid-a1", "kid-a2", "main-a"))).toEqual(["kid-a2"]);
		expect(ids(resolveTarget(members, "kid-a1", "implementer", "main-a"))).toEqual(["kid-a2"]);
		expect(ids(resolveTarget(members, "kid-a1x", "kid-a2", "kid-a1"))).toEqual(["kid-a2"]);
		expect(ids(resolveTarget(members, "kid-a1", "all", "main-a"))).toEqual(["main-a", "kid-a2", "kid-a1x"]);
		// The parent is not listed (left, or stalled and unlisted): its children are still one team.
		const orphans = members.filter((each) => each.id !== "main-a");
		expect(ids(resolveTarget(orphans, "kid-a1", "kid-a2", "main-a"))).toEqual(["kid-a2"]);
	});

	it("may answer an outsider who wrote to it", () => {
		expect(ids(resolveTarget(members, "kid-a1", "main-b", "main-a", "kid-a1", [], "main-b"))).toEqual(["main-b"]);
	});

	it("leaves a top-level sender's reach unchanged", () => {
		expect(ids(resolveTarget(members, "main-a", "kid-b1"))).toEqual(["kid-b1"]);
		expect(ids(resolveTarget(members, "main-a", "reviewer"))).toEqual(["kid-b1"]);
		expect(ids(resolveTarget(members, "main-b", "all"))).toEqual(["kid-b1"]);
	});
});

const started: Array<{ emit: (name: string, event: unknown, ctx: unknown) => Promise<unknown>; ctx: unknown }> = [];
afterEach(async () => {
	for (const agent of started.splice(0)) await agent.emit("session_shutdown", {}, agent.ctx);
});

/** Teams sharing one database in one repository: `agent()` is a top-level session, `agent(parent, id)` a subagent. */
function setup() {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const file = path.join(tmp(), "team.sqlite");
	const agent = async (parent?: string, id?: string) => {
		const fake = fakeHost();
		const env = {
			OCTOCODE_AGENT_DB: file,
			...(parent && id
				? {
						OCTOCODE_AGENT_ID: id,
						OCTOCODE_PARENT_ID: parent,
						OCTOCODE_AGENT_ROLE: "general",
						OCTOCODE_AGENT_GOAL: "help",
					}
				: {}),
		};
		const team = new Team(fake.api, env);
		registerCollab(fake.api, team, {});
		const ctx = fakeCtx({ cwd, hasUI: true });
		await fake.emit("session_start", {}, ctx);
		team.join("help");
		started.push({ emit: fake.emit, ctx });
		return team;
	};
	return { agent, cwd, file };
}

describe("messages between real teams", () => {
	it("refuses a child's message across trees and lets a parent send it", async () => {
		const { agent } = setup();
		const mainA = await agent();
		const mainB = await agent();
		const kid = await agent(mainA.id, "kid-a1");
		const other = await agent(mainB.id, "kid-b1");
		expect(await kid.send("kid-b1", "hi")).toEqual({
			error: `kid-b1 is outside your team; ask your coordinator (${mainA.id}) to relay.`,
		});
		expect(await kid.send(mainB.id, "hi")).toEqual({ error: expect.stringContaining("outside your team") });
		expect(await mainA.send("kid-b1", "hi")).toMatchObject({ sent: ["kid-b1"] });
		expect(await kid.send("parent", "hi")).toMatchObject({ sent: [mainA.id] });
		expect(other.id).toBe("kid-b1");
	});

	it("holds a stand-up: one broadcast reaches the whole tree and every reply returns to the sender", async () => {
		const { agent, cwd, file } = setup();
		const lead = await agent();
		const outsider = await agent();
		const kids = [await agent(lead.id, "kid-a1"), await agent(lead.id, "kid-a2")];
		const grandkid = await agent("kid-a1", "kid-a1x");
		await agent(outsider.id, "kid-b1");
		const call = await lead.send("all", "Stand-up: what blocks you?", { replyRequired: true });
		if (!("id" in call) || !("sent" in call)) throw new Error(JSON.stringify(call));
		expect([...call.sent].sort()).toEqual(["kid-a1", "kid-a1x", "kid-a2"]);
		for (const each of [...kids, grandkid])
			expect(await each.send(undefined, `${each.id}: blocked on review`, { replyTo: call.id })).toMatchObject({
				sent: [lead.id],
			});
		const store = TeamStore.open(cwd, file);
		try {
			const replies = store.pending(lead.id!).filter((message) => message.replyTo === call.id);
			expect(replies.map((message) => message.from).sort()).toEqual(["kid-a1", "kid-a1x", "kid-a2"]);
			expect(store.pending(outsider.id!).length).toBe(0);
		} finally {
			store.close();
		}
	});
});

describe("coordinate list details", () => {
	it("shows the item, its why and the log folders, each on one row, and nothing without data", async () => {
		const { cwd, file } = setup();
		const store = TeamStore.open(cwd, file);
		const agent = sharedDatabase({
			file,
			mirrorFile: `${file}.transcripts`,
			archiveDir: path.join(path.dirname(file), "archive"),
			privateParent: false,
		});
		try {
			const at = Date.now();
			const item = { goal: "", body: "", paths: "", evidence: "", plan: "", priority: 1, tags: "" };
			backlog.insertItem(agent.db, {
				...item,
				repo: store.workspaceId,
				seq: 7,
				title: "Tree-limited messaging",
				why: `Only parents talk across trees.\nSecond line stays out. ${"x".repeat(200)}`,
				state: "ongoing",
				createdBy: "user",
				sourceSession: null,
				at,
				fromItem: null,
				type: "feature",
			});
			agentRuns.begin(agent.db, {
				workspaceId: store.workspaceId,
				agentId: "kid-a1",
				parentAgentId: "main-a",
				goal: "help",
				backlog: { workspaceId: store.workspaceId, seq: 7 },
			});
			const folder = path.join(cwd, ".octocode", "code", "session-data", `x${"y".repeat(150)}`);
			sessions.locate(agent.db, "session-kid", cwd, folder);
			const kid = { ...member("kid-a1", "general", "main-a"), sessionId: "session-kid", checkout: cwd };
			const bare = member("kid-a2", "implementer", "main-a");
			const details = store.presence.details([kid, bare], store.workspaceId);
			expect(details.has("kid-a2")).toBe(false);
			const text = describeMembers([kid, bare], undefined, at, undefined, undefined, undefined, [], details);
			const lines = text.split("\n");
			expect(lines).toContain("  item B7 Tree-limited messaging");
			const why = lines.find((line) => line.startsWith("  why: "))!;
			expect(why).toBe("  why: Only parents talk across trees.");
			const log = lines.find((line) => line.startsWith("  log: "))!;
			expect(log.length).toBeLessThanOrEqual(100);
			expect(log.endsWith("y")).toBe(true);
			// The bare member's block has none of these lines.
			const bareBlock = text.slice(text.indexOf("kid-a2"));
			expect(bareBlock).not.toMatch(/ {2}(item|why:|log:|shell logs:) /);
			expect(describeMembers([kid], undefined, at)).not.toMatch(/ {2}(item|why:|log:) /);
		} finally {
			store.close();
		}
	});
});
