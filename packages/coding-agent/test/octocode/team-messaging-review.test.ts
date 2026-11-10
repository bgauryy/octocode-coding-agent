// Messaging review findings, each pinned by a test on real teams sharing one database.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageEnvelope } from "../../src/octocode/shared/messages.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const started: Array<{ emit: (name: string, event: unknown, ctx: unknown) => Promise<unknown>; ctx: unknown }> = [];
afterEach(async () => {
	for (const agent of started.splice(0)) await agent.emit("session_shutdown", {}, agent.ctx);
});

/** Teams sharing one database in one repository: `agent()` is a top-level session, `agent(parent, id)` a subagent. */
function setup() {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const file = path.join(tmp(), "team.sqlite");
	return async (parent?: string, id?: string) => {
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
}

const idOf = (result: Awaited<ReturnType<Team["send"]>>): number => {
	if (!("id" in result)) throw new Error(JSON.stringify(result));
	return result.id;
};

describe("replyTo opens a route only to a sender that wrote to you", () => {
	it("a subagent cannot reach another tree by replying to a message it never received", async () => {
		const agent = setup();
		const mainA = await agent();
		const mainB = await agent();
		const kid = await agent(mainA.id, "kid-a1");
		const outsider = await agent(mainB.id, "kid-b1");
		// kid-b1 writes to its own parent; kid-a1 holds no delivery of that message.
		const foreign = idOf(await outsider.send("parent", "status for my parent"));
		const refusal = { error: expect.stringContaining("outside your team") };
		expect(await kid.send(undefined, "hijack", { replyTo: foreign })).toEqual(refusal);
		expect(await kid.send("kid-b1", "hijack", { replyTo: foreign })).toEqual(refusal);
	});

	it("a subagent still answers an outsider who wrote to it, by replyTo alone", async () => {
		const agent = setup();
		const mainA = await agent();
		const mainB = await agent();
		const kid = await agent(mainA.id, "kid-a1");
		const question = idOf(await mainB.send("kid-a1", "what are you editing?", { replyRequired: true }));
		expect(await kid.send(undefined, "routing.ts", { replyTo: question })).toMatchObject({ sent: [mainB.id] });
	});
});

describe("a forward passes the outbound message hook with what the recipient reads", () => {
	it("shows the hook the forwarder's note and the forwarded message's reply request", async () => {
		const agent = setup();
		const lead = await agent();
		const asker = await agent(lead.id, "kid-a1");
		await agent(lead.id, "kid-a2");
		const question = idOf(await asker.send("parent", "who owns routing?", { replyRequired: true }));
		const seen: MessageEnvelope[] = [];
		lead.setMessageHook(async (message) => {
			seen.push(message);
			if (message.text.includes("SECRET")) throw new Error("Blocked by a PreMessageSend hook: secret");
		});
		expect(await lead.forwardMessage(question, lead.id!, "kid-a2", "token SECRET-123")).toEqual({
			error: "Blocked by a PreMessageSend hook: secret",
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ to: "kid-a2", replyRequired: true, wake: true, interrupt: false });
		seen.length = 0;
		expect(await lead.forwardMessage(question, lead.id!, "kid-a2", "you own it")).toMatchObject({ sent: ["kid-a2"] });
		expect(seen[0]?.text).toContain("you own it");
		expect(seen[0]?.text).toContain("who owns routing?");
	});
});
