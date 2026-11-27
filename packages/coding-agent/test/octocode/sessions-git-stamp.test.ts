import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb, sharedAgentDbWriter } from "../../src/storage/database.ts";
import { registerSessions } from "../../src/octocode/sessions/register.ts";
import { gitHeadStamp } from "../../src/octocode/sessions/git-stamp.ts";
import * as sessionStore from "../../src/octocode/sessions/store.ts";
import { SessionIndex } from "../../src/octocode/sessions/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let saved: { home?: string; db?: string };
beforeEach(() => {
	saved = { home: process.env.OCTOCODE_HOME, db: process.env.OCTOCODE_AGENT_DB };
	process.env.OCTOCODE_HOME = tmp();
	delete process.env.OCTOCODE_AGENT_DB;
});
afterEach(() => {
	vi.restoreAllMocks();
	closeSharedAgentDb();
	setCurrentSession(undefined);
	for (const [key, value] of [
		["OCTOCODE_HOME", saved.home],
		["OCTOCODE_AGENT_DB", saved.db],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe", encoding: "utf8" });

function repository(): string {
	const cwd = tmp();
	git(cwd, "init", "-q", "-b", "main");
	git(cwd, "commit", "-q", "--allow-empty", "-m", "one");
	return cwd;
}

function session(cwd: string, id = "sess-stamp") {
	const fake = fakeHost();
	registerSessions(fake.api, { commands: new Subcommands(), isSubagent: false });
	const file = path.join(tmp(), `${id}.jsonl`);
	fs.writeFileSync(file, "{}\n");
	const ctx = fakeCtx({ cwd, hasUI: true });
	Object.assign(ctx, {
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => file,
			getSessionDir: () => path.dirname(file),
			getSessionName: () => undefined,
			getEntries: () => [],
			getBranch: () => [],
		},
	});
	const settle = async () => {
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
		await sharedAgentDbWriter().drain(5_000);
	};
	const turn = async () => {
		await fake.fire("agent_end", { type: "agent_end", messages: [] }, ctx);
		await settle();
	};
	return { fake, ctx, id, settle, turn, row: () => new SessionIndex(sharedAgentDb()).get(id) };
}

describe("the session's git state", () => {
	it("runs git at start and again only after a turn moved HEAD or its branch, recording what git says", async () => {
		const cwd = repository();
		const asked = vi.spyOn(sessionStore, "gitState");
		const host = session(cwd);
		setCurrentSession(host.id);
		await host.fake.fire("session_start", { type: "session_start", reason: "startup" }, host.ctx);
		expect(asked).toHaveBeenCalledTimes(1);
		await vi.waitFor(() =>
			expect(host.row()).toMatchObject({ branch: "main", head: git(cwd, "rev-parse", "HEAD").trim() }),
		);
		await host.turn();
		await host.turn();
		expect(asked).toHaveBeenCalledTimes(1);
		git(cwd, "commit", "-q", "--allow-empty", "-m", "two");
		await host.turn();
		expect(asked).toHaveBeenCalledTimes(2);
		await vi.waitFor(() => expect(host.row()?.head).toBe(git(cwd, "rev-parse", "HEAD").trim()));
		git(cwd, "checkout", "-q", "-b", "feature");
		await host.turn();
		expect(asked).toHaveBeenCalledTimes(3);
		await vi.waitFor(() => expect(host.row()?.branch).toBe("feature"));
		// Packing the refs rewrites where the branch is kept: git is asked again, and says the same.
		git(cwd, "pack-refs", "--all");
		await host.turn();
		expect(asked).toHaveBeenCalledTimes(4);
		await vi.waitFor(() =>
			expect(host.row()).toMatchObject({ branch: "feature", head: git(cwd, "rev-parse", "HEAD").trim() }),
		);
		await host.settle();
		await host.turn();
		expect(asked).toHaveBeenCalledTimes(4);
	});

	it("stamps what gitState follows: HEAD, its loose or packed ref, a detached HEAD, a linked worktree", () => {
		const cwd = repository();
		const first = gitHeadStamp(cwd);
		expect(first).toBeDefined();
		expect(gitHeadStamp(path.join(cwd, "."))).toBe(first);
		git(cwd, "commit", "-q", "--allow-empty", "-m", "two");
		const moved = gitHeadStamp(cwd);
		expect(moved).not.toBe(first);
		git(cwd, "checkout", "-q", "--detach");
		const detached = gitHeadStamp(cwd);
		expect(detached).not.toBe(moved);
		const linked = path.join(tmp(), "linked");
		git(cwd, "worktree", "add", "-q", "-b", "side", linked);
		const side = gitHeadStamp(linked);
		expect(side).toBeDefined();
		git(linked, "commit", "-q", "--allow-empty", "-m", "side");
		expect(gitHeadStamp(linked)).not.toBe(side);
		// Outside a repository the stamp is the folder's; GIT_DIR makes git look elsewhere, so git is asked.
		const plain = tmp();
		expect(gitHeadStamp(plain)).toBe(gitHeadStamp(plain));
		expect(gitHeadStamp(plain, { GIT_DIR: path.join(cwd, ".git") })).toBeUndefined();
	});
});
