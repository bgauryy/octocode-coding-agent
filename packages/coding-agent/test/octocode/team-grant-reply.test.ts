// B117: `coordinate grant` answers the child's open budget question, so the ask closes and the child resumes at once.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestBudget, RunningBudgets } from "../../src/octocode/subagents/budget.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { grantRequests } from "../../src/octocode/team/tools/grant.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const started: Array<{ emit: (name: string, event: unknown, ctx: unknown) => Promise<unknown>; ctx: unknown }> = [];
afterEach(async () => {
	for (const agent of started.splice(0)) await agent.emit("session_shutdown", {}, agent.ctx);
});

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

const budgetsFor = (id: string) => {
	const budgets = new RunningBudgets();
	budgets.add(id, new RequestBudget(4, vi.fn(), vi.fn()));
	return budgets;
};

const idOf = (result: Awaited<ReturnType<Team["send"]>>): number => {
	if (!("id" in result)) throw new Error(JSON.stringify(result));
	return result.id;
};

describe("coordinate grant answers the child's open question", () => {
	it("closes the one open ask and leaves nothing pending for the child", async () => {
		const agent = setup();
		const main = await agent();
		const kid = await agent(main.id, "kid-1");
		const question = idOf(await kid.send("parent", "may I have more requests?", { replyRequired: true }));
		expect(main.asks(kid.id!, main.id!, 0)[0]?.answer).toBeUndefined();

		const result = await grantRequests(main, budgetsFor("kid-1"), "kid-1", 5);

		const [ask] = main.asks(kid.id!, main.id!, 0);
		expect(ask).toMatchObject({ id: question, answer: { by: main.id } });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining(`answers its question #${question}`) });
		// The parent's own pending view holds no open question from the child.
		expect(main.openQuestions().filter((q) => q.from === "kid-1")).toEqual([]);
	});

	it("leaves an ambiguous or absent ask alone: a proactive grant stays an FYI", async () => {
		const agent = setup();
		const main = await agent();
		const kid = await agent(main.id, "kid-1");
		await grantRequests(main, budgetsFor("kid-1"), "kid-1", 2);
		expect(main.asks(kid.id!, main.id!, 0)).toEqual([]);
		const first = idOf(await kid.send("parent", "budget?", { replyRequired: true }));
		const second = idOf(await kid.send("parent", "also, which branch?", { replyRequired: true }));
		await grantRequests(main, budgetsFor("kid-1"), "kid-1", 2);
		expect(main.asks(kid.id!, main.id!, 0).map((a) => [a.id, a.answer === undefined])).toEqual([
			[first, true],
			[second, true],
		]);
	});
});
