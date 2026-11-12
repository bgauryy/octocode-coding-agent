import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-isolated-start-");
	resetOctocodeEnv();
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team", "team.sqlite"),
	});
	// runSubagent re-runs the current `octocode` script: point it at the scripted stand-in.
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

function repo(): string {
	const dir = fs.realpathSync(tmp("octocode-isolated-repo-"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "user.email", "test@example.com");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

describe("an isolated background start", () => {
	it("names the child's worktree and the ref its result lands on", async () => {
		const f = fakeHost();
		const team = new Team(f.api);
		const control = registerAgentTool(f.api, {
			profiles: () => new Map(),
			team,
			permission: fakePermission(),
			refused: () => new Map(),
		});
		const ctx = fakeCtx({ cwd: repo(), hasUI: true });
		// The parent asks "Trust new worktree?" and the user says yes.
		Object.assign(ctx.ui, { confirm: async () => true });
		team.start(ctx);
		try {
			const result = await f.tools
				.get("agent")
				.execute(
					"call-1",
					{ goal: "work apart", task: "edit a file", background: true, isolate: true },
					undefined,
					undefined,
					ctx,
				);
			const started = result.content[0].text as string;
			const id = result.details.id as string;
			expect(started).toMatch(new RegExp(`^Started ${id} \\(`));
			expect(started).toContain(`Works in its own worktree ${id}`);
			expect(started).toContain(`refs/octocode/${id}`);
			await control.settle();
		} finally {
			await control.stopAll();
			team.stop();
		}
	}, 60_000);
});
