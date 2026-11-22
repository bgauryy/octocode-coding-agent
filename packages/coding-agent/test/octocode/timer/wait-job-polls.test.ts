import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentDb, openDatabase } from "../../../../db/src/api.ts";
import { timerFields } from "../../../src/octocode/timer/model.ts";
import { registerTimers } from "../../../src/octocode/timer/register.ts";
import type { LiveJob } from "../../../src/octocode/timer/job-poll.ts";
import { fakeCtx, fakeHost } from "../fake-host.ts";
import { tmp } from "../helpers.ts";

let root: string;
let agent: AgentDb;

beforeEach(() => {
	root = tmp();
	agent = openDatabase({
		file: path.join(root, "workspaces.db"),
		mirrorFile: path.join(root, "transcripts.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
});
afterEach(() => {
	agent.close();
	fs.rmSync(root, { recursive: true, force: true });
});

const job = (): LiveJob => ({
	id: "bash-3",
	pid: 79777,
	log: path.join(root, ".octocode/agent/tmp/build.log"),
	command: "yarn run build:offline --target web",
});

function session(jobs: () => readonly LiveJob[]) {
	const host = fakeHost();
	const agentDir = path.join(root, "agent-home");
	fs.mkdirSync(agentDir, { recursive: true });
	registerTimers(host.api, {
		reservation: () => undefined,
		agent: () => "me",
		env: { ...process.env, OCTOCODE_AGENT_DB: path.join(root, "workspaces.db") },
		agentDir,
		jobs,
	});
	const ctx = {
		...fakeCtx({ cwd: root }),
		sessionManager: { getSessionId: () => "s1", getBranch: () => [], getEntries: () => [] },
	};
	return { host, ctx };
}

const poll = (command: string) => ({ event: "check.result", filter: { command } });

describe("wait on a command that polls a job whose end already wakes the session", () => {
	it.each([
		"! kill -0 79777",
		"while kill -0 79777 2>/dev/null; do sleep 1; done",
		"test -e ROOT/.octocode/agent/tmp/build.log",
		"[ -f .octocode/agent/tmp/build.log ]",
		"pgrep -f 'yarn run build:offline'",
	])("refuses %s, naming the job", async (shown) => {
		const command = shown.replace("ROOT", root);
		const { host, ctx } = session(() => [job()]);
		await host.fire("session_start", { reason: "startup" }, ctx);
		await expect(
			host.tools.get("notify").execute("c", { op: "on", note: "n", ...poll(command) }, undefined, undefined, ctx),
		).rejects.toThrow("You are already notified when bash-3 ends");
	});

	it.each(["test -e .octocode/agent/tmp/task-4.out", "until ! tasks show task-4 | grep running; do sleep 1; done"])(
		"refuses %s while task-4 runs, naming the job",
		async (command) => {
			const { host, ctx } = session(() => [{ id: "task-4" }]);
			await host.fire("session_start", { reason: "startup" }, ctx);
			const on = (shown: string) =>
				host.tools.get("notify").execute("c", { op: "on", note: "n", ...poll(shown) }, undefined, undefined, ctx);
			await expect(on(command)).rejects.toThrow("You are already notified when task-4 ends");
			await on("test -e other.txt");
			await on("echo task-44");
		},
	);

	it("lets through polls of anything that is not a live job of the session", async () => {
		const { host, ctx } = session(() => [job()]);
		await host.fire("session_start", { reason: "startup" }, ctx);
		const on = (command: string) =>
			host.tools.get("notify").execute("c", { op: "on", note: "n", ...poll(command) }, undefined, undefined, ctx);
		await on("kill -0 12345");
		await on(`test -e ${root}/dist/out.js`);
		await on("pgrep -f 'vite dev'");
	});

	it("lets the same polls through when the session has no such job", async () => {
		const { host, ctx } = session(() => []);
		await host.fire("session_start", { reason: "startup" }, ctx);
		await host.tools
			.get("notify")
			.execute("c", { op: "on", note: "n", ...poll("! kill -0 79777") }, undefined, undefined, ctx);
	});
});

describe("the missing-note error", () => {
	const owner = { workspaceId: "w", sessionId: "s", cwd: "/tmp" };

	it("names the op the call used", () => {
		expect(() => timerFields({ op: "on", until: { command: "true" } }, 0, owner)).toThrow("on needs a note");
		expect(() => timerFields({ op: "set", after: 60 }, 0, owner)).toThrow("set needs a note");
		expect(() => timerFields({ after: 60 }, 0, owner)).toThrow("set needs a note");
	});
});

describe("the wait row", () => {
	it("prints the event once for an on call", () => {
		const host = fakeHost();
		registerTimers(host.api, {
			reservation: () => undefined,
			agent: () => "me",
			env: { ...process.env, OCTOCODE_AGENT_DB: path.join(root, "workspaces.db") },
		});
		const tool = host.tools.get("notify");
		const args = { op: "on", event: "check.result", filter: { command: "! kill -0 79777" }, note: "build ended" };
		const row = JSON.stringify(tool.display({ args }));
		expect(row).toContain("Notify me when");
		expect(row).not.toMatch(/\bon on\b/);
		expect(row).toMatch(/`! kill -0 79777` exits 0/);
		// An event that is not valid yet shows the name it was given, still once.
		expect(JSON.stringify(tool.display({ args: { op: "on", event: "nope" } }))).not.toMatch(/\bon on\b/);
		expect(JSON.stringify(tool.display({ args: { op: "on" } }))).not.toMatch(/\bon on\b/);
	});
});
