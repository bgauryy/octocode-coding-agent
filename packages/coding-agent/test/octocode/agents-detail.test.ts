import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import { agentsCommand } from "../../src/octocode/subagents/command.ts";
import { agentDetail, agentDetailPageText } from "../../src/octocode/subagents/detail/content.ts";
import { findMember } from "../../src/octocode/subagents/detail/lookup.ts";
import type { Team } from "../../src/octocode/team/session.ts";

const NOW = 10_000_000;
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "researcher",
	pid: 1,
	status: "working",
	joinedAt: NOW - 125_000,
	updatedAt: NOW - 3_000,
	toolCalls: 12,
	input: 100_000,
	cacheRead: 75_000,
	output: 4_000,
	cost: 0.42,
	unpriced: false,
	...extra,
});
const message = (id: number, from: string, to: string[], text: string): Traffic => ({
	id,
	from,
	to,
	text,
	at: NOW - 60_000,
	state: "delivered",
});

describe("agent lookup", () => {
	const members = [member("plucky-eel"), member("plump-owl"), member("sly-shell")];
	it("finds an exact id and a unique prefix", () => {
		expect(findMember(members, "plump-owl")).toEqual({ member: members[1] });
		expect(findMember(members, "sly")).toEqual({ member: members[2] });
	});
	it("lists candidates for an unknown name and for an ambiguous prefix", () => {
		expect(findMember(members, "nobody")).toEqual({
			error: 'No agent "nobody". Agents: plucky-eel, plump-owl, sly-shell',
		});
		const ambiguous = findMember(members, "pl");
		expect("error" in ambiguous && ambiguous.error).toContain("plucky-eel, plump-owl");
	});
});

describe("agent detail", () => {
	const detail = agentDetail({
		member: member("plucky-eel", {
			parentId: "misty-turtle",
			model: "opus",
			goal: `Build the page\n${"x".repeat(300)}`,
			activity: "bash: yarn test",
			locks: ["src/a.ts", "src/b/"],
			branch: "feat/x",
			cwd: "/repo",
		}),
		now: NOW,
		details: { item: { seq: 553, title: "Agent page", why: "", more: 0 }, transcripts: "/logs" },
		traffic: [
			message(2, "misty-turtle", ["plucky-eel"], "start now"),
			message(1, "other", ["third"], "unrelated"),
			message(0, "plucky-eel", ["parent"], "done?"),
		],
		reportPath: "/r/report.md",
	});
	const facts = Object.fromEntries(detail.facts);

	it("carries the fields users ask for", () => {
		expect(facts.name).toBe("plucky-eel");
		expect(facts.role).toBe("researcher · parent misty-turtle");
		expect(facts.model).toBe("opus");
		expect(facts.status).toBe("working");
		expect(facts.elapsed).toContain("seen 3s ago");
		expect(facts.tokens).toContain("75% cached");
		expect(facts.cost).toBe("≈$0.42");
		expect(facts.goal).toContain("x".repeat(300));
		expect(facts.activity).toBe("bash: yarn test");
		expect(facts.item).toBe("B553 Agent page");
		expect(facts.worktree).toBe("feat/x · /repo");
		expect(facts.holds).toBe("src/a.ts, src/b/");
		expect(facts.report).toBe("/r/report.md");
	});
	it("shows only its own messages, with direction", () => {
		expect(facts.messages).toContain("#2 from misty-turtle");
		expect(facts.messages).toContain("#0 to parent");
		expect(facts.messages).not.toContain("unrelated");
	});
	it("marks a failed run broken and escapes control characters", () => {
		const failed = agentDetail({
			member: member("a", { status: "settled", outcome: "failed", goal: "bad\u001b[31m" }),
			now: NOW,
			traffic: [],
		});
		expect(failed.state).toBe("broken");
		expect(Object.fromEntries(failed.facts).goal).not.toContain("\u001b");
		expect(Object.fromEntries(failed.facts).holds).toBe("no files reserved");
	});
	it("renders aligned text", () => {
		const text = agentDetailPageText(detail);
		expect(text).toMatch(/^name\s+plucky-eel$/m);
		expect(text).toMatch(/^messages\s+#2 from misty-turtle/m);
	});
});

describe("/agents <name> without a UI", () => {
	afterEach(() => vi.restoreAllMocks());
	const team = (members: Member[]) =>
		({
			id: "misty-turtle",
			members: () => members,
			snapshot: () => ({ members, traffic: [message(5, "misty-turtle", ["plucky-eel"], "hello")] }),
			audit: { details: () => new Map(), recent: () => [], resolve: () => undefined },
		}) as unknown as Team;
	const run = async (members: Member[], args: string) => {
		const written: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});
		const command = agentsCommand(team(members), new Map());
		await command.handler(args, { hasUI: false, cwd: "/", ui: { notify() {} } } as never);
		return written.join("");
	};

	it("prints the detail as text for a prefix", async () => {
		const out = await run([member("plucky-eel", { goal: "do it" })], "pluck");
		expect(out).toContain("plucky-eel");
		expect(out).toContain("goal");
		expect(out).toContain("#5 from misty-turtle");
	});
	it("names the candidates for an unknown agent", async () => {
		const out = await run([member("plucky-eel")], "zzz");
		expect(out).toContain('No agent "zzz". Agents: plucky-eel');
	});
});
