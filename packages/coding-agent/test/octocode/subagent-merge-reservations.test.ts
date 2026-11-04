import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { afterEach, describe, expect, it } from "vitest";
import { agentsCommand } from "../../src/octocode/subagents/command.ts";
import { mergeChild } from "../../src/octocode/subagents/merge-child.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const ID = "general-r2merge";

/** A repository whose isolated child `ID` saved a change to `child.txt` on `refs/octocode/<ID>`, not merged yet. */
function repoWithRef(): string {
	const dir = fs.realpathSync(tmp("octocode-merge-lease-"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "user.email", "test@example.com");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	const base = git(dir, "rev-parse", "HEAD");
	fs.writeFileSync(path.join(dir, "child.txt"), "from the child\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "child");
	git(dir, "update-ref", `refs/octocode/${ID}`, "HEAD");
	git(dir, "reset", "-q", "--hard", base);
	return dir;
}

const peer = (id: string): Member => ({
	id,
	role: "peer",
	pid: process.pid,
	status: "idle",
	joinedAt: 1_000,
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});

const teams: Team[] = [];
afterEach(() => {
	for (const team of teams.splice(0)) team.stop();
});

/** `/agents merge <ID>` in a session of `cwd`, with `child.txt` reserved by another agent when `reserved`. */
async function merge(cwd: string, reserved: boolean, hasUI: boolean, confirms: boolean[] = []) {
	const env = { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") };
	if (reserved) {
		const store = TeamStore.open(cwd, env.OCTOCODE_AGENT_DB);
		store.save(peer("peer-0002"));
		expect(store.lock("peer-0002", [{ path: "child.txt", kind: "file", reason: "rewriting it" }])).toMatchObject({
			ok: true,
		});
		store.close();
	}
	const team = new Team({ sendMessage: () => undefined, appendEntry: () => undefined } as never, env);
	teams.push(team);
	const ctx = fakeCtx({ cwd, hasUI });
	ctx.ui.confirms.push(...confirms);
	team.start(ctx);
	await agentsCommand(team, new Map()).handler(`merge ${ID}`, ctx);
	return { ctx, merged: fs.existsSync(path.join(cwd, "child.txt")) };
}

describe("coordinate merge", () => {
	const setupMerge = async (reserved: boolean, mode: "full" | "manual" = "full") => {
		const cwd = repoWithRef();
		const env = { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") };
		if (reserved) {
			const store = TeamStore.open(cwd, env.OCTOCODE_AGENT_DB);
			store.save(peer("peer-0002"));
			store.lock("peer-0002", [{ path: "child.txt", kind: "file", reason: "rewriting it" }]);
			store.close();
		}
		const team = new Team({ sendMessage: () => undefined, appendEntry: () => undefined } as never, env);
		teams.push(team);
		const ctx = fakeCtx({ cwd, hasUI: mode === "manual" });
		team.start(ctx);
		return { cwd, team, ctx, permission: fakePermission(mode) };
	};

	it("merges through the same contract as /agents merge: the ref goes and the tree has the change", async () => {
		const { cwd, team, ctx, permission } = await setupMerge(false);
		const result = await mergeChild(team, permission, ID, ctx);
		expect(result).toMatchObject({ ok: true, text: expect.stringContaining(`Merged refs/octocode/${ID} into main.`) });
		expect(fs.existsSync(path.join(cwd, "child.txt"))).toBe(true);
		expect(() => git(cwd, "rev-parse", "--verify", "--quiet", `refs/octocode/${ID}`)).toThrow();
	});

	it("refuses a ref that changes a file another agent reserved, keeping the ref", async () => {
		const { cwd, team, ctx, permission } = await setupMerge(true);
		const result = await mergeChild(team, permission, ID, ctx);
		expect(result).toMatchObject({ ok: false, reserved: true });
		expect(result.text).toContain("child.txt is reserved by peer-0002");
		expect(fs.existsSync(path.join(cwd, "child.txt"))).toBe(false);
		expect(git(cwd, "rev-parse", "--verify", `refs/octocode/${ID}`)).toBeTruthy();
	});

	it("follows the permission mode: a refused ask writes nothing", async () => {
		const { cwd, team, ctx, permission } = await setupMerge(false, "manual");
		ctx.ui.confirms.push(false);
		const result = await mergeChild(team, permission, ID, ctx);
		expect(result.ok).toBe(false);
		expect(fs.existsSync(path.join(cwd, "child.txt"))).toBe(false);
	});

	it("is offered to the agent that starts subagents and not to a subagent", () => {
		const starter = fakeHost();
		registerCollab(starter.api, new Team(starter.api), {
			stopAgent: () => undefined,
			mergeAgent: async () => ({ ok: true, text: "" }),
		});
		const leaf = fakeHost();
		registerCollab(leaf.api, new Team(leaf.api));
		const actions = (host: typeof starter) => JSON.stringify(host.tools.get("coordinate").parameters.properties.action);
		expect(actions(starter)).toContain("merge");
		expect(actions(leaf)).not.toContain("merge");
	});
});

describe("/agents merge and path reservations", () => {
	it("refuses to merge a ref that changes a file another agent reserved, when nobody can be asked", async () => {
		const cwd = repoWithRef();
		const { ctx, merged } = await merge(cwd, true, false);
		expect(merged).toBe(false);
		const note = ctx.ui.notes.at(-1)!;
		expect(note.type).toBe("warning");
		expect(note.message).toContain(`Not merged: ${ID} changes reserved files.`);
		expect(note.message).toContain("child.txt is reserved by peer-0002 (rewriting it;");
		expect(git(cwd, "rev-parse", "--verify", `refs/octocode/${ID}`)).toBeTruthy();
	});

	it("asks the user, and merges only when the user overrides the reservation", async () => {
		const declined = repoWithRef();
		expect((await merge(declined, true, true, [false])).merged).toBe(false);
		const accepted = repoWithRef();
		const { ctx, merged } = await merge(accepted, true, true, [true]);
		expect(merged).toBe(true);
		expect(ctx.ui.notes.at(-1)!.message).toContain(`Merged refs/octocode/${ID} into main.`);
	});

	it("merges without asking when nothing it changes is reserved", async () => {
		const cwd = repoWithRef();
		const { ctx, merged } = await merge(cwd, false, true);
		expect(merged).toBe(true);
		expect(ctx.ui.confirms).toEqual([]);
	});
});
