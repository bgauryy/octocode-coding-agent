import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TEAM_ENTRY, teamNameToResume } from "../../src/octocode/team/session/rejoin.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** One session file's custom entries, as the host persists `appendEntry` calls. */
const asEntries = (log: Array<{ customType: string; data: unknown }>) =>
	log.map((entry, index) => ({ type: "custom" as const, id: `e${index}`, parentId: null, timestamp: "", ...entry }));
const ctx = () =>
	({
		cwd: tmp(),
		sessionManager: { getSessionId: () => "sess-team", getSessionFile: () => undefined },
		isIdle: () => true,
	}) as never;
const started: Team[] = [];
const team = (env: NodeJS.ProcessEnv) => {
	const host = fakeHost();
	const member = new Team(host.api, env);
	started.push(member);
	return { team: member, entries: host.entries as Array<{ customType: string; data: unknown }> };
};

describe("resuming a session rejoins the team", () => {
	afterEach(() => {
		for (const member of started.splice(0)) member.stop();
	});

	it("records the name once when a top-level session joins, and rejoins under it on resume", () => {
		const env = { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") };
		const first = team(env);
		first.team.start(ctx());
		const name = first.team.join("ship it").id;
		first.team.join();
		expect(first.entries.filter((entry) => entry.customType === TEAM_ENTRY)).toEqual([
			{ customType: TEAM_ENTRY, data: { version: 1, id: name } },
		]);
		first.team.stop();

		const resumed = team(env);
		resumed.team.start(ctx(), teamNameToResume(asEntries(first.entries), "resume"));
		// Joined straight away, before any team action, under the same name: peers and the footer see it again.
		expect(resumed.team.id).toBe(name);
		expect(resumed.team.members().map((member) => member.id)).toContain(name);
		// The same name is not written again.
		expect(resumed.entries).toEqual([]);
	});

	it("rejoins on startup (--continue) and reload, but a new or forked session starts a new identity", () => {
		const entries = asEntries([{ customType: TEAM_ENTRY, data: { version: 1, id: "inky-kraken" } }]);
		for (const reason of ["startup", "reload", "resume"] as const)
			expect(teamNameToResume(entries, reason)).toBe("inky-kraken");
		for (const reason of ["new", "fork"] as const) expect(teamNameToResume(entries, reason)).toBeUndefined();
		// The latest record wins; malformed or unsafe ones are ignored.
		const later = asEntries([
			{ customType: TEAM_ENTRY, data: { version: 1, id: "inky-kraken" } },
			{ customType: TEAM_ENTRY, data: { version: 1, id: "brave-squid" } },
		]);
		expect(teamNameToResume(later, "resume")).toBe("brave-squid");
		for (const data of [{ version: 2, id: "x-y" }, { version: 1, id: "\u001b[31mred" }, { version: 1 }, "inky"])
			expect(teamNameToResume(asEntries([{ customType: TEAM_ENTRY, data }]), "resume")).toBeUndefined();
	});

	it("takes a fresh name, and records it, when another running agent holds the old one", () => {
		const cwd = tmp();
		const file = path.join(tmp(), "team.sqlite");
		// Another running process (this test's parent) holds the name.
		const store = TeamStore.open(cwd, file);
		const now = Date.now();
		store.save({
			id: "inky-kraken",
			role: "main",
			pid: process.ppid,
			status: "idle",
			joinedAt: now,
			updatedAt: now,
			toolCalls: 0,
			input: 0,
			cacheRead: 0,
			output: 0,
			cost: 0,
			unpriced: false,
		});
		const resumed = team({ OCTOCODE_AGENT_DB: file });
		resumed.team.start(
			{
				cwd,
				sessionManager: { getSessionId: () => "sess-team", getSessionFile: () => undefined },
				isIdle: () => true,
			} as never,
			"inky-kraken",
		);
		const id = resumed.team.id;
		expect(id).toBeDefined();
		expect(id).not.toBe("inky-kraken");
		expect(resumed.entries).toEqual([{ customType: TEAM_ENTRY, data: { version: 1, id } }]);
	});

	it("never records a subagent's name: its parent chose it", () => {
		const child = team({ OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite"), OCTOCODE_AGENT_ID: "zesty-eel" });
		child.team.start(ctx(), "inky-kraken");
		expect(child.team.id).toBe("zesty-eel");
		expect(child.entries).toEqual([]);
	});

	it("follows a main agent's session switch and links a child's display name to its own session", () => {
		const env = { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") };
		const cwd = tmp();
		const session = (id: string) =>
			({
				cwd,
				sessionManager: { getSessionId: () => id, getSessionFile: () => undefined },
				isIdle: () => true,
			}) as never;
		const main = team(env);
		main.team.start(session("sess-a"));
		const id = main.team.join("ship it").id;
		const sessionOf = (name: string) => main.team.members().find((member) => member.id === name)?.sessionId;
		expect(sessionOf(id)).toBe("sess-a");
		// /resume switches the session in this process: the team is left and joined again for the new one.
		main.team.start(session("sess-b"), id);
		expect(sessionOf(id)).toBe("sess-b");

		const child = team({ ...env, OCTOCODE_AGENT_ID: "zesty-eel", OCTOCODE_PARENT_ID: id });
		child.team.start(session("child-session"));
		expect(sessionOf("zesty-eel")).toBe("child-session");
	});

	it("a session with no recorded name joins under a new one when it starts and records it", () => {
		// O6b (design B36): a main session joins the team at session_start, not on its first team action.
		const fresh = team({ OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") });
		fresh.team.start(ctx());
		expect(fresh.team.id).toBeDefined();
		expect(fresh.entries).toEqual([{ customType: "octocode-team", data: { version: 1, id: fresh.team.id } }]);
	});
});
