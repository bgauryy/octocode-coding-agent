import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { BACKLOG_ITEM_ENV, PARENT_SESSION_ENV, TEAM_WORKSPACE_ENV } from "../../../common/src/env.ts";
import { closeSharedAgentDb, workspaces } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/config/database.ts";
import { registeredWorkspace } from "../../src/config/workspace-database.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { RepoCatalog } from "../../src/octocode/web-daemon/repos.ts";
import { SessionRegistry } from "../../src/octocode/web-daemon/sessions.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

it("isolates worktree boards and retains named history after a checkout goes away", () => {
	const root = fs.realpathSync(tmp());
	const env = { OCTOCODE_HOME: path.join(root, "home") };
	const main = path.join(root, "one", "demo");
	const linked = path.join(root, "two", "demo");
	fs.mkdirSync(main, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", ["-C", main, ...args], { stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "--allow-empty", "-qm", "base");
	git("worktree", "add", "--detach", linked);
	const agent = sharedAgentDb(env);
	try {
		const board = (cwd: string) => openBacklog(fakeCtx({ cwd }), { isSubagent: false, env }).store;
		const first = board(main);
		const mainGit = path.join(main, ".git");
		// A child launched by a Git hook may inherit the parent's repository override.
		vi.stubEnv("GIT_DIR", mainGit);
		vi.stubEnv("GIT_WORK_TREE", main);
		const second = (() => {
			try {
				return board(linked);
			} finally {
				vi.unstubAllEnvs();
			}
		})();
		expect(first.repo).not.toBe(second.repo);
		const commonDir = mainGit;
		expect(workspaces.byId(agent.db, first.repo)?.git).toEqual({ commonDir, linkedWorktree: false });
		expect(workspaces.byId(agent.db, second.repo)?.git).toEqual({ commonDir, linkedWorktree: true });
		expect(first.add({ title: "Main", createdBy: "user" }).ref).toBe("B1");
		expect(second.add({ title: "Linked", createdBy: "user" }).ref).toBe("B1");
		expect(first.get("B1")?.title).toBe("Main");
		const subdir = path.join(linked, "src");
		fs.mkdirSync(subdir);
		expect(board(subdir).get("B1")?.title).toBe("Linked");
		const delegated = openBacklog(fakeCtx({ cwd: linked }), {
			isSubagent: true,
			env: { ...env, [PARENT_SESSION_ENV]: "p", [BACKLOG_ITEM_ENV]: "B1", [TEAM_WORKSPACE_ENV]: main },
		});
		expect(delegated.store.get("B1")?.title).toBe("Main");

		const copy = path.join(root, "forged");
		fs.cpSync(path.join(main, ".octa"), path.join(copy, ".octa"), { recursive: true });
		expect(() => registeredWorkspace(copy, agent)).toThrow(/different directory/);
		git("worktree", "remove", "--force", linked);
		expect(
			workspaces
				.byName(agent.db, "demo")
				.map((item) => item.id)
				.sort(),
		).toEqual([first.repo, second.repo].sort());

		const catalog = new RepoCatalog(env, new SessionRegistry(env, () => {}));
		const saved = catalog.resolve(second.repo);
		expect(saved).toMatchObject({ name: "demo", id: second.repo, sessions: 0 });
		expect(saved?.root).toBeUndefined();
		expect(catalog.store(second.repo).get("B1")?.title).toBe("Linked");
	} finally {
		closeSharedAgentDb();
	}
});
