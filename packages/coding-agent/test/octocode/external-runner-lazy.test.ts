import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectedRunners, runnerRows } from "../../src/octocode/external/connected.ts";
import { runnerTurn, runnerTurnDeps } from "../../src/octocode/external/runner-session.ts";
import * as status from "../../src/octocode/external/runner-status.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { RUNNERS } from "../../src/octocode/external/runners.ts";

const permission = () => async () => ({ outcome: { outcome: "cancelled" as const } });
/** Every runner selected, so the installed fixtures alone decide what is listed. */
const ALL = RUNNERS.map((runner) => runner.id);
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function fixture() {
	const home = tmp("octocode-lazy-runners-");
	const bin = path.join(home, "bin");
	const agent = path.join(home, "agent");
	const runs = path.join(home, "runs");
	const login = path.join(home, "login");
	fs.mkdirSync(bin);
	fs.mkdirSync(agent);
	fs.writeFileSync(login, "plan");
	for (const name of ["claude", "opencode", "codex"]) {
		fs.writeFileSync(
			path.join(bin, name),
			`#!${process.execPath}
const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(runs)}, ${JSON.stringify(name)}+':'+process.argv.slice(2).join(' ')+'\\n');
if(process.argv.includes('--version')) {console.log('9.0.0');process.exit(0)}
const state=fs.readFileSync(${JSON.stringify(login)},'utf8');
if(state==='unknown') {console.log('status unavailable');process.exit(0)}
console.log(${JSON.stringify(name)}==='claude' ? JSON.stringify({loggedIn:state==='plan',authMethod:'claude.ai'}) : '[{"provider":"opencode","type":"api"}]');
`,
			{ mode: 0o755 },
		);
	}
	vi.stubEnv("HOME", home);
	vi.stubEnv("OCTOCODE_HOME", agent);
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agent);
	vi.stubEnv("PATH", bin);
	const calls = () => (fs.existsSync(runs) ? fs.readFileSync(runs, "utf8").trim().split("\n") : []);
	return { home, login, calls };
}

describe("lazy installed runners", () => {
	it("declares runnable installed CLIs without status commands and honors disable", () => {
		const fx = fixture();
		const runners = connectedRunners(true, permission, ALL);
		expect(runners.ids).toEqual(["claude-code", "codex", "opencode"]);
		expect(runners.states.every((state) => state.auth === undefined)).toBe(true);
		expect(runnerRows(runners.states).join("\n")).toContain("sign-in checked when used");
		expect(connectedRunners(false, permission, ALL).ids).toEqual([]);
		expect(fx.calls()).toEqual([]);
	});

	it("checks only the selected runner and reuses its valid positive cache", async () => {
		const fx = fixture();
		const deps = runnerTurnDeps(permission);
		const signal = new AbortController().signal;
		expect(await deps.launch("claude-code", signal)).toMatchObject({ billing: "plan", route: "headless" });
		expect(fx.calls()).toEqual(["claude:--version", "claude:auth status --json"]);
		expect(await deps.launch("claude-code", signal)).toMatchObject({ billing: "plan" });
		expect(fx.calls()).toHaveLength(2);
		expect(runnerRows(connectedRunners(true, permission, ALL).states).join("\n")).toContain("claude.ai · plan");
	});

	it.each(["unknown", "signedout"])(
		"rechecks cached %s state on the next use without a file-stamp change",
		async (state) => {
			const fx = fixture();
			fs.writeFileSync(fx.login, state);
			const deps = runnerTurnDeps(permission);
			const signal = new AbortController().signal;
			await expect(deps.launch("claude-code", signal)).rejects.toThrow(
				state === "unknown" ? /could not be confirmed/ : /is signed out/,
			);
			const rows = runnerRows(connectedRunners(true, permission, ALL).states).join("\n");
			expect(rows).toContain(state === "unknown" ? "sign-in unknown" : "signed out");
			if (state === "unknown") expect(rows).not.toContain("signed out");
			fs.writeFileSync(fx.login, "plan");
			expect(await deps.launch("claude-code", signal)).toMatchObject({ billing: "plan" });
			expect(fx.calls()).toHaveLength(4);
		},
	);

	it("does not launch after cancellation during the selected runner check", async () => {
		const fx = fixture();
		const controller = new AbortController();
		const checked = vi.spyOn(status, "checkRunners").mockImplementation(async (options) => {
			expect(options?.ids).toEqual(["opencode"]);
			expect(options?.signal).toBe(controller.signal);
			controller.abort(new Error("cancelled check"));
			return [{ id: "opencode", name: "OpenCode", cli: true, adapter: true, auth: { signedIn: true } }];
		});
		const deps = runnerTurnDeps(permission);
		const connect = vi.spyOn(deps, "connect");
		const input = {
			runner: "opencode",
			cwd: fx.home,
			text: "task",
			signal: controller.signal,
			onActivity: () => {},
			ctx: fakeCtx({ cwd: fx.home }),
		};
		await expect(runnerTurn(input, deps)).rejects.toThrow("cancelled check");
		expect(checked).toHaveBeenCalledOnce();
		expect(connect).not.toHaveBeenCalled();
		await expect(runnerTurn(input, deps)).rejects.toThrow("cancelled check");
		expect(checked).toHaveBeenCalledOnce();
	});
});
