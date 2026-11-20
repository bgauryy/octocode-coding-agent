import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ToolCallEvent, ToolCallEventResult } from "../../src/core/features/index.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { isolatedTreeRefusal } from "../../src/octocode/permission/isolated-tree.ts";
import type { GateVerdict } from "../../src/octocode/permission/judge.ts";
import {
	decide,
	declaredPermissions,
	kindOf,
	parseGrants,
	SPAWN_GRANTABLE,
	UNGRANTABLE,
} from "../../src/octocode/permission/mode.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { gitLandings } from "../../src/octocode/permission/shell/git-landing.ts";
import { gitStateMutation } from "../../src/octocode/permission/shell/git-state.ts";
import { reservationTargets, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { evaluateSourcePolicy, unprojectedSourcePolicy } from "../../src/octocode/permission/source-policy.ts";
import { parseSourcePolicy } from "../../src/octocode/permission/source-policy/rules.ts";
import {
	AGENT_SCRATCH_ENV,
	PERMISSION_ENV,
	PERMISSION_GRANTS_ENV,
	READ_ONLY_ENV,
	SUBAGENT_ENV,
	TEAM_WORKSPACE_ENV,
} from "@octocodeai/octocode-common/env";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { registerToolGates, type ToolGatesOptions } from "../../src/octocode/tool-gates.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * Edge cases across the permission layers that no other test pins. Each `it` names the layer and the contract
 * (docs/permissions.md) it holds.
 */

beforeAll(shellParserReady);

const timerCall = (command: string): ToolCallEvent => ({
	type: "tool_call",
	toolCallId: "timer-1",
	toolName: "wait",
	input: { op: "on", note: "wait", event: "check.result", filter: { command } },
});

const bashCall = (command: string): ToolCallEvent => ({
	type: "tool_call",
	toolCallId: "bash-1",
	toolName: "bash",
	input: { command },
});

function repo(): string {
	const dir = fs.realpathSync(tmp());
	execSync("git init -q", { cwd: dir });
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src/a.ts"), "original");
	return dir;
}

/**
 * Layer: the invariants before the permission step (git-state, reservations). A `timer` with an until-command is
 * "decided as the bash call that command is" (tool-gates.ts `timerOperation`), and the command then runs on the bash
 * tool's foreground path every 15 s. Only the permission step sees the bash form; the git-state and reservation steps
 * see `toolName: "wait"` and let it through.
 */
describe("a timer's until-command meets the invariants a bash call meets", () => {
	it("is refused git state in a shared-tree subagent, as the same bash call is (full mode)", async () => {
		const f = fakeHost();
		const env = { [SUBAGENT_ENV]: "1" };
		const ctx = fakeCtx({ cwd: tmp() });
		const permission = new Permission({ api: f.api, env: { [PERMISSION_ENV]: "full" }, isSubagent: true });
		permission.start(ctx);
		registerToolGates(f.api, {
			permission,
			provenance: { check: () => undefined },
			annotations: () => undefined,
			collab: { reservationGate: async () => undefined },
			hooks: { preToolUse: async () => undefined },
			sourcePolicy: { refresh: async () => undefined },
			activity: { checking: () => undefined },
			localReads: new Map(),
			env,
		} as unknown as ToolGatesOptions);
		const fire = async (event: ToolCallEvent) =>
			(await f.fire("tool_call", event, ctx)) as ToolCallEventResult | undefined;
		// The bash call is refused by the invariant (pinned in permission-git-state.test.ts)...
		expect(await fire(bashCall("git commit -am wip"))).toMatchObject({ block: true });
		// ...and the same command as a timer condition must be too: it runs repeatedly, unattended.
		expect(await fire(timerCall("git commit -am wip"))).toMatchObject({ block: true });
	});

	/** The gate as tool-gates.ts runs it in the main session, with a Claude `permissions` policy and a PreToolUse hook. */
	function mainSession(
		rules: Record<string, string[]>,
		hookDenies: (event: ToolCallEvent) => boolean = () => false,
		gates: {
			preToolUse?: (event: ToolCallEvent) => Promise<GateVerdict | undefined>;
			reservationGate?: (event: ToolCallEvent) => Promise<GateVerdict | undefined>;
		} = {},
	) {
		const f = fakeHost();
		const cwd = fs.realpathSync.native(tmp());
		const ctx = fakeCtx({ cwd, hasUI: false });
		const permission = new Permission({ api: f.api, env: { [PERMISSION_ENV]: "full" }, isSubagent: false });
		permission.start(ctx);
		const policy = parseSourcePolicy(
			{ permissions: rules },
			{ path: "/home/test/.claude/settings.json", anchor: "/home/test/.claude" },
		);
		permission.setSourcePolicy(
			(invocation, at) => evaluateSourcePolicy(policy, invocation, at),
			(name) => unprojectedSourcePolicy(policy, name),
		);
		registerToolGates(f.api, {
			permission,
			provenance: { check: () => undefined },
			annotations: () => undefined,
			collab: { reservationGate: gates.reservationGate ?? (async () => undefined) },
			hooks: {
				preToolUse:
					gates.preToolUse ??
					(async (event: ToolCallEvent) => (hookDenies(event) ? { block: true, reason: "hook denied" } : undefined)),
			},
			sourcePolicy: { refresh: async () => undefined },
			activity: { checking: () => undefined },
			localReads: new Map(),
			env: {},
		} as unknown as ToolGatesOptions);
		return async (event: ToolCallEvent) => (await f.fire("tool_call", event, ctx)) as ToolCallEventResult | undefined;
	}

	it("is refused by a Claude Bash deny rule, as the same bash call is (rules apply in every mode)", async () => {
		const fire = mainSession({ deny: ["Bash(git push:*)"] });
		expect(await fire(bashCall("git push --force origin main"))).toMatchObject({ block: true });
		expect(await fire(timerCall("git push --force origin main"))).toMatchObject({ block: true });
	});

	it("reaches a PreToolUse hook as the bash call it is, so a hook deny on bash refuses it", async () => {
		// A Claude-style hook matched on the shell tool (`Bash`) never sees `toolName: "wait"`.
		const fire = mainSession({}, (event) => event.toolName === "bash" && /rm -rf/.test(String(event.input.command)));
		expect(await fire(bashCall("rm -rf build"))).toMatchObject({ block: true });
		expect(await fire(timerCall("rm -rf build"))).toMatchObject({ block: true });
	});

	it("refuses a timer whose until-command a PreToolUse hook rewrote: the rewrite never reaches the timer", async () => {
		// A hook rewrite of a bash call stands (it is checked again); for a timer it would change only the bash form.
		const rewrite = async (event: ToolCallEvent): Promise<GateVerdict | undefined> => {
			if (event.toolName !== "bash") return undefined;
			event.input.command = "echo rewritten";
			return { rewritten: true };
		};
		const fire = mainSession({}, undefined, { preToolUse: rewrite });
		expect((await fire(bashCall("echo original")))?.block).toBeFalsy();
		const timer = timerCall("echo original");
		expect(await fire(timer)).toMatchObject({
			block: true,
			reason: expect.stringMatching(/rewrote its command/),
		});
		expect(timer.input).toEqual({
			op: "on",
			note: "wait",
			event: "check.result",
			filter: { command: "echo original" },
		});
	});

	it("refuses a timer whose until-command the reservation gate rewrote (Node confinement)", async () => {
		const confine = async (event: ToolCallEvent): Promise<GateVerdict | undefined> => {
			if (event.toolName === "bash") event.input.command = `${String(event.input.command)} --permission`;
			return undefined;
		};
		const fire = mainSession({}, undefined, { reservationGate: confine });
		expect(await fire(timerCall("node -e 1"))).toMatchObject({ block: true });
	});

	it("still sets a timer whose until-command passes every check, and hands it a revalidation", async () => {
		const fire = mainSession({});
		const result = await fire(timerCall("test -f done.txt"));
		expect(result?.block).toBeFalsy();
		expect(typeof result?.revalidate).toBe("function");
	});

	describe("while a peer holds a reservation", () => {
		const shutdowns: Array<() => Promise<void>> = [];
		afterEach(async () => {
			for (const stop of shutdowns.splice(0)) await stop();
		});

		function member(dbFile: string, cwd: string) {
			const fake = fakeHost();
			const team = new Team(fake.api, { OCTOCODE_AGENT_DB: dbFile });
			const collab = registerCollab(fake.api, team, {
				shellWrites: async (command) => {
					await shellParserReady();
					return reservationTargets(command);
				},
			});
			const ctx = fakeCtx({ cwd });
			shutdowns.push(async () => void (await fake.emit("session_shutdown", {}, ctx)));
			return { fake, team, collab, ctx };
		}

		it("refuses a timer whose until-command writes the reserved path, as it refuses the bash call", async () => {
			const cwd = tmp();
			const db = path.join(tmp(), "team.sqlite");
			const peer = member(db, cwd);
			const me = member(db, cwd);
			await peer.fake.emit("session_start", {}, peer.ctx);
			await me.fake.emit("session_start", {}, me.ctx);
			peer.team.join();
			me.team.join();
			const permission = new Permission({ api: me.fake.api, env: { [PERMISSION_ENV]: "full" }, isSubagent: false });
			permission.start(me.ctx);
			registerToolGates(me.fake.api, {
				permission,
				provenance: { check: () => undefined },
				collab: me.collab,
				hooks: { preToolUse: async () => undefined },
				sourcePolicy: { refresh: async () => undefined },
				activity: { checking: () => undefined },
				localReads: new Map(),
			} as unknown as ToolGatesOptions);
			peer.team.lock(["shared.txt"], "editing");
			const fire = async (event: ToolCallEvent) =>
				(await me.fake.fire("tool_call", event, me.ctx)) as ToolCallEventResult | undefined;
			expect(await fire(bashCall("echo hi > shared.txt"))).toMatchObject({ block: true });
			expect(await fire(timerCall("echo hi > shared.txt"))).toMatchObject({ block: true });
		});
	});
});

/**
 * Layer: the merge rule through bash (`worktree.merge`, shell/git-landing.ts). The sibling git-state reader
 * (shell/git-state.ts) already reads a heredoc and `echo … | sh`, and the mutation parse reads `find -exec`; the landing
 * reader reads only `sh -c` and `eval`, so the same line lands on the default branch in `full` with no ask.
 */
describe("the landing reader sees the scripts its sibling readers see", () => {
	it.each([
		["sh <<'EOF'\ngit merge feature\nEOF"],
		["echo 'git merge feature' | sh"],
		["bash -s <<< 'git merge feature'"],
		["find . -maxdepth 0 -exec git merge feature \\;"],
	])("finds the landing in %j", (line) => {
		expect(gitLandings(line, {}).map((each) => each.command)).toContain("git merge");
	});

	it.each([["echo 'git merge feature'; sh"], ["sh build.sh"], ["find . -name '*.ts' -exec grep -l merge {} \\;"]])(
		"finds no landing in %j (guard: a shell not fed the script, and a find payload that is no git call)",
		(line) => {
			expect(gitLandings(line, {})).toEqual([]);
		},
	);

	it("places a heredoc's landing in the directory the shell runs in", () => {
		expect(gitLandings("cd /work/sub && sh <<'EOF'\ngit merge feature\nEOF", {})).toMatchObject([
			{ command: "git merge", dirs: ["/work/sub/"] },
		]);
	});

	it("matches git-state's reading of the same heredoc and pipe (guard: the sibling sees them today)", () => {
		expect(gitStateMutation("sh <<'EOF'\ngit merge feature\nEOF")).toBe("git merge");
		expect(gitStateMutation("echo 'git merge feature' | sh")).toBe("git merge");
	});
});

/**
 * Layer: the read-only role and isolation (read-only-role.ts, isolated-tree.ts). Both refuse "the writes the shell
 * parser finds". The parse records the database `sqlite3` opens for writing (`ShellMutation.databases`), but only the
 * state-folder check reads that field, so a read-only reviewer can drop a table in a workspace database and an
 * isolated child can change the main tree's database in `full`.
 */
describe("a database write the parse finds is a write for the role guards", () => {
	it("refuses a read-only child's sqlite3 write to a workspace database", () => {
		const cwd = repo();
		const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };
		const event = { toolName: "bash", input: { command: "sqlite3 src/app.db 'DROP TABLE users'" } };
		expect(readOnlyRoleRefusal(event, cwd, env)).toMatch(/read-only role/);
		// Guard: `-readonly` stays a read.
		const read = { toolName: "bash", input: { command: "sqlite3 -readonly src/app.db 'select 1'" } };
		expect(readOnlyRoleRefusal(read, cwd, env)).toBeUndefined();
	});

	it("refuses an isolated child's sqlite3 write to the main tree's database", () => {
		const main = repo();
		const worktree = repo();
		const scratch = path.join(main, ".octocode/code/temp/agents/impl-1");
		fs.mkdirSync(scratch, { recursive: true });
		const env = { [SUBAGENT_ENV]: "1", [TEAM_WORKSPACE_ENV]: main, [AGENT_SCRATCH_ENV]: scratch };
		const event = { toolName: "bash", input: { command: `sqlite3 ${main}/app.db 'DELETE FROM users'` } };
		expect(isolatedTreeRefusal(event, worktree, env)).toMatch(/isolated/);
	});
});

/**
 * Layer: the read-only role's shell reading. sed's `w` command and `gawk -i inplace` are read as writes
 * (sed-script.ts, awk-program.ts `awkEffect`), and awk is a "writer judged by its words" under xargs, but awk's own
 * output redirection inside its program is not read, so a reviewer can rewrite a source file with it.
 */
describe("awk's in-program output redirection is a write", () => {
	it.each([[`awk '{ print > "src/a.ts" }' src/a.ts`], [`awk '{ print | "tee src/a.ts" }' src/a.ts`]])(
		"refuses %j in a read-only child",
		(command) => {
			const cwd = repo();
			const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };
			expect(readOnlyRoleRefusal({ toolName: "bash", input: { command } }, cwd, env)).toMatch(/read-only role/);
		},
	);

	it("still lets a read-only child print with awk (guard)", () => {
		const cwd = repo();
		const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };
		const command = `awk '{ print $1 }' src/a.ts`;
		expect(readOnlyRoleRefusal({ toolName: "bash", input: { command } }, cwd, env)).toBeUndefined();
	});

	it("refuses awk's system() in a read-only child", () => {
		const cwd = repo();
		const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };
		const command = `awk 'BEGIN { system("rm -rf src") }'`;
		expect(readOnlyRoleRefusal({ toolName: "bash", input: { command } }, cwd, env)).toMatch(/system\(\)/);
	});

	// The fail-safe allowlist reads the raw program: a `|` or `>` in a regex, comparison or string is refused too.
	it.each([
		[`awk '/error|warn/ { print }' src/a.ts`],
		[`awk '$1 > 5 { print ($2 > 3) }' src/a.ts`],
		[`awk '{ s = s "|" $1 } END { print s }' src/a.ts`],
	])("refuses %j in a read-only child: the allowlist does not tell a regex, comparison or string apart", (command) => {
		const cwd = repo();
		const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };
		expect(readOnlyRoleRefusal({ toolName: "bash", input: { command } }, cwd, env)).toMatch(/read-only role/);
	});

	it.each([[`awk -F'|' '{ print $1 }' src/a.ts`]])(
		"lets a read-only child run %j: a `|` separator (guard)",
		(command) => {
			const cwd = repo();
			const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };
			expect(readOnlyRoleRefusal({ toolName: "bash", input: { command } }, cwd, env)).toBeUndefined();
		},
	);
});

/**
 * Layer: spawn grants (mode.ts `SPAWN_GRANTABLE`, `parseGrants`). docs/permissions.md: "No profile permission and no spawn
 * grant answers" browser cookie access; a child's cookie ask reaches the user through its parent each time.
 */
describe("browser cookie access never passes to a child", () => {
	it("is not spawn-grantable, and a child drops it from the grants its parent handed down", () => {
		expect(SPAWN_GRANTABLE.has("browser.cookies")).toBe(false);
		expect([...parseGrants({ [PERMISSION_GRANTS_ENV]: "browser.cookies,net.private" })]).toEqual(["net.private"]);
	});
});

/** Desktop control asks in every mode, can't be allowed for a session, and reaches a child only through its profile's declaration. */
describe("desktop control asks every time and passes to a child only by declaration", () => {
	it("is declarable by a profile, has no session kind, and `bypass` alone allows it", () => {
		expect(declaredPermissions(["desktop.control", "browser.cookies"])).toEqual({
			declared: ["desktop.control"],
			ignored: ["browser.cookies"],
		});
		expect(SPAWN_GRANTABLE.has("desktop.control")).toBe(true);
		expect(kindOf("desktop.control")).toBeUndefined();
		expect(UNGRANTABLE.has("desktop.control")).toBe(true);
		expect((["manual", "workspace", "full", "bypass"] as const).map((mode) => decide(mode, "desktop.control"))).toEqual(
			["ask", "ask", "ask", "allow"],
		);
	});
});

/**
 * Layer: Claude source rules (source-policy/match.ts `operations`). docs/permissions.md: a timer with an until-command is
 * both a `timer` call and the `Bash` call its command is, so a deny or ask on either name applies, and an allow needs both.
 */
describe("a timer with an until-command answers to timer and Bash rules", () => {
	const cwd = "/work";
	const decide = (rules: Record<string, string[]>) =>
		evaluateSourcePolicy(
			parseSourcePolicy(
				{ permissions: rules },
				{ path: "/home/test/.claude/settings.json", anchor: "/home/test/.claude" },
			),
			{
				toolName: "wait",
				input: { note: "wait", event: "check.result", filter: { command: "test -f done.txt" } },
			} as never,
			cwd,
		).decision;

	it.each([
		[{ deny: ["wait"] }, "deny"],
		[{ ask: ["wait"] }, "ask"],
		[{ deny: ["Bash(test:*)"] }, "deny"],
		[{ ask: ["Bash"] }, "ask"],
	])("applies %j to it", (rules, decision) => {
		expect(decide(rules)).toBe(decision);
	});

	it("allows it only when both timer and its command are allowed", () => {
		expect(decide({ allow: ["Bash(test:*)"] })).toBe("none");
		expect(decide({ allow: ["wait"] })).toBe("none");
		expect(decide({ allow: ["wait", "Bash(test:*)"] })).toBe("allow");
	});

	it("leaves a timer without an until-command a timer call (guard)", () => {
		const policy = parseSourcePolicy(
			{ permissions: { deny: ["Bash"] } },
			{ path: "/home/test/.claude/settings.json", anchor: "/home/test/.claude" },
		);
		expect(evaluateSourcePolicy(policy, { toolName: "wait", input: { note: "wait" } } as never, cwd).decision).toBe(
			"none",
		);
	});
});

/**
 * Layer: the landing reader (shell/git-landing.ts). `find -execdir` and `-okdir` run their payload in the directory of
 * each match, under find's starting points, not where find runs.
 */
describe("find -execdir lands where find looks", () => {
	it.each([["-execdir"], ["-okdir"]])("places a %s payload under find's start operand", (action) => {
		expect(gitLandings(`find /w -maxdepth 0 ${action} git merge feature \\;`, {})).toMatchObject([
			{ command: "git merge", dirs: ["/w"] },
		]);
		expect(gitLandings(`cd /base && find sub -maxdepth 0 ${action} git merge feature \\;`, {})).toMatchObject([
			{ command: "git merge", dirs: ["/base/sub"] },
		]);
	});

	it("reports nothing when the start operand cannot be placed", () => {
		expect(gitLandings(`find "$ROOT" -maxdepth 0 -execdir git merge feature \\;`, {})).toEqual([]);
	});

	it("keeps -exec where find runs (guard)", () => {
		expect(gitLandings(`find /w -maxdepth 0 -exec git merge feature \\;`, {})).toMatchObject([
			{ command: "git merge", dirs: [""] },
		]);
	});
});
