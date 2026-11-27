import fs from "node:fs";
import path from "node:path";
import { animationClock, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_NAMES } from "../../src/octocode/team/identity.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { openWidgetLines as widgetLines } from "./two-line-panel.ts";
import { describeMembers } from "../../src/octocode/team/member-list.ts";
import { messageText, resolveTarget } from "../../src/octocode/team/routing.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { fakeCtx, fakeHost, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { AGENT_GOAL_ENV, AGENT_ID_ENV, AGENT_ROLE_ENV } from "../../src/octocode/team/store/env.ts";

// Reduced motion draws a running light as a full ⏺: an animation or a state, never a half-filled circle held still.
beforeEach(() => animationClock.setReducedMotion(true));
afterEach(() => animationClock.setReducedMotion(false));

const NOW = 1_000_000;
const member = (id: string, role: string, extra: Partial<Member> = {}): Member => ({
	id,
	role,
	pid: process.pid,
	status: "idle",
	joinedAt: NOW - 60_000,
	updatedAt: NOW,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});
const dir = () => {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	return cwd;
};
const session = (env: NodeJS.ProcessEnv, cwd: string, db: string) => {
	const fake = fakeHost();
	const team = new Team(fake.api, { OCTOCODE_AGENT_DB: db, ...env });
	team.start(fakeCtx({ cwd }));
	return { team, ...fake };
};

describe("agent identity on the team", () => {
	it("names a main session from the closed list, with the role main and the join note as its goal", () => {
		const { team } = session({}, dir(), path.join(tmp(), "team.sqlite"));
		const me = team.join("audit auth token refresh");
		expect(AGENT_NAMES).toContain(me.id);
		expect(me).toMatchObject({ role: "main", goal: "audit auth token refresh" });
		// Joining again keeps the name and replaces the goal.
		expect(team.join("write the docs").id).toBe(me.id);
		expect(team.members()[0]).toMatchObject({ id: me.id, role: "main", goal: "write the docs" });
	});

	it("gives each process its own name: never one a live member of the shared database holds", () => {
		const cwd = dir();
		const db = path.join(tmp(), "team.sqlite");
		const names = new Set<string>();
		for (let i = 0; i < 12; i++) names.add(session({}, cwd, db).team.join().id);
		expect(names.size).toBe(12);
		const store = TeamStore.open(cwd, db);
		expect(store.names().sort()).toEqual([...names].sort());
		store.close();
	});

	it("proposes a new name that avoids live members, finished subagents and names the caller holds", () => {
		const { team } = session({}, dir(), path.join(tmp(), "team.sqlite"));
		const me = team.join();
		const finished = AGENT_NAMES.find((name) => name !== me.id)!;
		team.rememberFinished(finished, "its report reached you.");
		const held = AGENT_NAMES.find((name) => name !== me.id && name !== finished)!;
		for (let i = 0; i < 200; i++) expect([me.id, finished, held]).not.toContain(team.newName([held]));
	});

	it("takes a subagent's name, role and goal from the parent that started it", () => {
		const cwd = dir();
		const db = path.join(tmp(), "team.sqlite");
		const parent = session({}, cwd, db).team.join();
		const child = session(
			{
				[AGENT_ID_ENV]: "inky-kraken",
				[AGENT_ROLE_ENV]: "reviewer",
				[AGENT_GOAL_ENV]: "audit auth token refresh",
				OCTOCODE_PARENT_ID: parent.id,
			},
			cwd,
			db,
		);
		expect(child.team.join()).toMatchObject({
			id: "inky-kraken",
			role: "reviewer",
			goal: "audit auth token refresh",
			parentId: parent.id,
		});
	});

	it("still resolves a target by its role", () => {
		const members = [
			member("main-aaaaaa", "main"),
			member("inky-kraken", "reviewer"),
			member("salty-squid", "implementer"),
		];
		expect((resolveTarget(members, "main-aaaaaa", "reviewer") as Member[]).map((m) => m.id)).toEqual(["inky-kraken"]);
		expect((resolveTarget(members, "main-aaaaaa", "salty-squid") as Member[]).map((m) => m.id)).toEqual([
			"salty-squid",
		]);
	});

	it("refuses a blank coordinate join goal and accepts a long one whole", async () => {
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") });
		registerCollab(fake.api, team, { stopAgent: () => undefined });
		const ctx = fakeCtx({ cwd: dir() });
		await fake.emit("session_start", {}, ctx);
		const coordinate = fake.tools.get("coordinate");
		await expect(coordinate.execute("c", { action: "join", goal: "   " }, undefined, undefined, ctx)).rejects.toThrow(
			/goal is required/,
		);
		// O6b (design B36): a main session joins at session_start, without a goal; the refused join changes nothing.
		const name = team.id;
		expect(name).toBeDefined();
		expect(team.members()[0]?.goal).toBeUndefined();
		await coordinate.execute(
			"c",
			{ action: "join", goal: "refactor the whole auth module today please" },
			undefined,
			undefined,
			ctx,
		);
		expect(team.members()[0]).toMatchObject({
			id: name,
			role: "main",
			goal: "refactor the whole auth module today please",
		});
		expect(coordinate.parameters.properties.goal).not.toHaveProperty("maxLength");
		await fake.emit("session_shutdown", {}, ctx);
	});
});

describe("what the team shows about an agent", () => {
	const team = [
		member("salty-squid", "main", { goal: "ship the release" }),
		member("inky-kraken", "implementer", {
			parentId: "salty-squid",
			status: "working",
			joinedAt: NOW - 518_000,
			toolCalls: 56,
			cost: 2.28,
			goal: "audit auth token refresh",
			activity: "Thinking",
			model: "claude-opus-5-5",
			locks: Array.from({ length: 20 }, (_, i) => `src/${i}.ts`),
			pending: 0,
		}),
		member("deep-nautilus", "reviewer", {
			parentId: "salty-squid",
			joinedAt: NOW - 45_000,
			goal: "review parser changes",
		}),
	];

	it("draws tree, mark, name and goal › activity in aligned columns, the role, model and spend under an open row, within the width", () => {
		const lines = widgetLines(team, "salty-squid", NOW, theme, 150);
		// The root row is grid row 0 in the same columns, with no detail line of its own.
		// An agent's detail line says its role and model, then its time, cost and counts ending at the terminal's edge.
		// Idle agents draw ○: ⏺ means running only.
		const edge = (left: string, right: string) =>
			`${left}${" ".repeat(150 - visibleWidth(left) - visibleWidth(right))}${right}`;
		expect(lines).toEqual([
			" 🦑 salty-squid ○  · ship the release",
			" ├ ⏺ inky-kraken   · audit auth token refresh › Thinking",
			edge(" │   implementer · claude-opus-5-5", "8m38s · ≈$2.28 · 56 tool calls · 20 locks"),
			" └ ○ deep-nautilus · review parser changes",
			edge("     reviewer", "45s"),
		]);
		for (const index of [2, 4]) expect(visibleWidth(lines[index])).toBe(150);
		// The goals start in one column on every row, the roles in one column on every detail line.
		expect(lines[1].indexOf("audit")).toBe(lines[0].indexOf("ship the release"));
		expect(lines[3].indexOf("review parser")).toBe(lines[0].indexOf("ship the release"));
		expect(lines[2].indexOf("implementer")).toBe(lines[4].indexOf("reviewer"));
		for (const width of [150, 100, 70, 60, 59, 54, 50, 40])
			for (const line of widgetLines(team, "salty-squid", NOW, theme, width))
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("keeps name, mark and the stats line's model and tokens when the terminal is narrow, moving the action below before cutting", () => {
		// Token usage fills the optional stats columns, so narrowing has something to drop.
		const busy = team.map((m) =>
			m.id === "inky-kraken" ? { ...m, input: 1_200_000, cacheRead: 1_128_000, output: 35_000 } : m,
		);
		const at = (width: number, members = busy) => widgetLines(members, "salty-squid", NOW, theme, width);
		const kept = ["claude-opus-5-5", "107k tok", "20 locks"];
		const head = " ├ ⏺ inky-kraken   · audit auth token refresh";
		const who = " │   implementer · claude-opus-5-5";
		// A short action beside a whole goal: nothing is cut, on the head row or the stats line.
		const wide = at(104);
		expect(wide[1]).toBe(`${head} › Thinking`);
		expect(wide[2]).toBe(`${who}     8m38s · ≈$2.28 · 107k tok · 94% cached · 56 tool calls · 20 locks`);
		// The stats line drops its tool calls first; the head row holds no spend, so nothing leaves it.
		const medium = at(100);
		expect(medium[1]).toBe(`${head} › Thinking`);
		expect(medium[2]).toBe(`${who}                 8m38s · ≈$2.28 · 107k tok · 94% cached · 20 locks`);
		// Then the cached share leaves.
		const narrow = at(80);
		expect(narrow[1]).toBe(`${head} › Thinking`);
		expect(narrow[2]).toBe(`${who}          8m38s · ≈$2.28 · 107k tok · 20 locks`);
		// The head row is whole down to the last width of the grid.
		const slim = at(70);
		const tighter = at(60);
		for (const lines of [slim, tighter]) expect(lines[1]).toBe(`${head} › Thinking`);
		// A longer action that no longer fits whole moves to a ↳ line and the goal stays whole.
		const acting = busy.map((m) =>
			m.id === "inky-kraken" ? { ...m, activity: "→ localSearch refreshToken in packages/auth/src" } : m,
		);
		expect(at(100, acting)[1]).toBe(`${head} › → localSearch refreshToken in packages/auth/src`);
		const below = at(90, acting);
		expect(below[1]).toBe(head);
		expect(below[2]).toBe(`${who}       8m38s · ≈$2.28 · 107k tok · 94% cached · 20 locks`);
		// Under the goal column, which keeps room for it.
		expect(below[3]).toBe(" │                   ↳ → localSearch refreshToken in packages/auth/src");
		expect(below[3].indexOf("↳")).toBe(below[1].indexOf("audit"));
		// Without that room, under the name.
		expect(at(60, acting)[3]).toBe(" │   ↳ → localSearch refreshToken in packages/auth/src");
		// Below 60 columns, the narrow form: `mark name`, the goal, the stats, then `↳ action`.
		const compact = at(59);
		expect(compact.slice(1, 3)).toEqual([" ├ ⏺ inky-kraken", " │   audit auth token refresh"]);
		// The time and the cost give way before the model, tokens and locks are cut.
		expect(compact[3]).toBe(" │   implementer · claude-opus-5-5      107k tok · 20 locks");
		expect(compact[4]).toBe(" │   ↳ Thinking");
		expect(compact.join("\n")).not.toMatch(/working/);
		// The stats line keeps its model, tokens and locks at every width.
		for (const [width, lines] of [
			[104, wide],
			[100, medium],
			[80, narrow],
			[70, slim],
			[60, tighter],
		] as const)
			for (const text of kept) expect(lines[2], `${width} columns`).toContain(text);
		for (const text of ["claude-opus-5-5", "107k tok"]) expect(compact[3], "59 columns").toContain(text);
	});

	it("lists name, role and goal in `coordinate list` and /agents", () => {
		const text = describeMembers(team, "salty-squid", NOW + 10_000);
		expect(text).toContain("inky-kraken · implementer · working · claude-opus-5-5 · parent salty-squid");
		// Idle with a working child: the session waits on it, so neither line says idle.
		expect(text).toContain("salty-squid (you) · main · waiting");
		expect(text).toContain("  waiting on 1 agent");
		expect(text).toContain("  goal: audit auth token refresh");
		expect(text).toContain("  Thinking");
		expect(text).toContain("  goal: review parser changes");
		expect(text).toContain("56 tool calls · ≈$2.28");
		const cached = describeMembers(
			[
				member("salty-squid", "main", {
					toolCalls: 3,
					input: 1_200_000,
					cacheRead: 1_128_000,
					output: 35_000,
					unpriced: true,
				}),
			],
			"salty-squid",
			NOW,
		);
		expect(cached).toContain("3 tool calls · ↑72k +1.1M cached ↓35k · cost n/a");
		expect(cached).toContain("salty-squid (you) · main · idle");
	});

	it("names the sender's role and goal in the header of a message", () => {
		const base = { id: 12, to: "salty-squid", text: "found it", at: 0, replyRequired: true };
		const peer = messageText({
			...base,
			from: "inky-kraken",
			sender: { role: "reviewer", goal: "audit auth token refresh" },
		});
		expect(peer).toContain("Message #12 from agent inky-kraken (reviewer: audit auth token refresh) at ");
		expect(
			messageText(
				{ ...base, from: "inky-kraken", sender: { role: "reviewer", goal: "audit auth token refresh" } },
				{ parentId: "inky-kraken" },
			),
		).toContain("from your coordinator inky-kraken (reviewer: audit auth token refresh) at ");
		expect(messageText({ ...base, from: "inky-kraken", sender: { role: "reviewer" } })).toContain(
			"from agent inky-kraken (reviewer) at ",
		);
		// The sender already left: only its name remains.
		expect(messageText({ ...base, from: "inky-kraken" })).toContain("from agent inky-kraken at ");
		expect(messageText({ ...base, from: "user" }, { fromUser: true })).toContain("from the user at ");
	});

	it("reads the sender's role and goal from the team database when a message is delivered", () => {
		const cwd = dir();
		const store = TeamStore.open(cwd, path.join(tmp(), "team.sqlite"));
		store.save(
			member("inky-kraken", "reviewer", { goal: "audit auth token refresh", joinedAt: NOW, pid: process.pid }),
		);
		store.save(member("salty-squid", "main"));
		store.send("inky-kraken", ["salty-squid"], "found it", { replyRequired: false }, NOW);
		expect(store.pending("salty-squid")[0]).toMatchObject({
			from: "inky-kraken",
			sender: { role: "reviewer", goal: "audit auth token refresh" },
		});
		store.close();
	});

	it("strips terminal escapes from another process's goal and role", () => {
		const evil = [
			member("x-y", "main"),
			member("evil-agent", "rev\u001b[2Jiewer", {
				parentId: "x-y",
				goal: "goal\u001b]0;pwned\u0007 here",
				status: "working",
			}),
		];
		expect(widgetLines(evil, "x-y", NOW, theme, 150).join("\n")).not.toMatch(/\u001b|pwned/);
		// The model reads this text: the controls stay as visible escapes, never raw.
		const described = describeMembers(evil, "x-y", NOW);
		expect(described).not.toMatch(/\u001b|\u0007/);
		expect(described).toContain("rev\\u{1b}[2Jiewer");
		expect(described).toContain("goal: goal\\u{1b}]0;pwned\\u{7} here");
	});
});
