import fs from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { openDatabase, timers } from "../../../db/src/api.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { timerTool } from "../../src/octocode/native/tools/notify/tool.ts";
import type { ConditionDeps } from "../../src/octocode/timer/conditions/types.ts";
import { tmp } from "./helpers.ts";

function setup(children: string[]) {
	const root = tmp();
	const agent = openDatabase({
		file: path.join(root, "workspaces.db"),
		mirrorFile: path.join(root, "transcripts.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
	const workspace = registeredWorkspace(root, agent).id;
	const tool = timerTool({
		db: () => agent,
		workspaceId: () => workspace,
		agent: () => "me",
		now: () => Date.UTC(2026, 10, 6, 12),
		deps: { agentEnd: () => undefined } as unknown as ConditionDeps,
		children: () => children,
		implicit: () => "",
		checkRefusal: async () => undefined,
		cronRefusal: async () => undefined,
		cronCap: () => 2,
		sessionUsd: () => 0,
		changed: () => undefined,
	});
	const ctx = { cwd: root, sessionManager: { getSessionId: () => "s1" } } as never;
	const run = (args: object) => tool.execute("c", { note: "n", ...args } as never, undefined, undefined, ctx);
	const accepted = (args: object) => Value.Check(tool.validationParameters!, { reason: "r", note: "n", ...args });
	const close = () => {
		agent.close();
		fs.rmSync(root, { recursive: true, force: true });
	};
	return { run, accepted, close, active: () => timers.activeCount(agent.db, "s1") };
}

describe("notify takes the shapes models send", () => {
	it.each([
		[{ op: "set", delay: 30 }],
		[{ op: "set", seconds: 30 }],
		[{ op: "set", interval: 60 }],
		[{ op: "on", event: "agent.ended", filter: { name: "x" } }],
		[{ op: "on", event: "check.result", filter: { job: "bash-1" } }],
	])("validates %j", (args) => {
		const t = setup([]);
		try {
			expect(t.accepted(args)).toBe(true);
			expect(t.accepted({ op: "set", bogus: 1 })).toBe(false);
		} finally {
			t.close();
		}
	});

	it.each([
		["delay", { op: "set", delay: 30 }],
		["seconds", { op: "set", seconds: 30 }],
		["interval", { op: "set", interval: 60 }],
		["on with a time", { op: "on", after: 30 }],
		["on time.due", { op: "on", event: "time.due", after: 30 }],
		["set with an event", { op: "set", event: "agent.ended", filter: { agent: "x" } }],
		["agent named by name", { op: "on", event: "agent.ended", filter: { name: "x" } }],
		["agent from the filter alone", { op: "on", filter: { agent: "x" } }],
		["command alone", { op: "on", filter: { command: "test -f a" } }],
	])("sets a wait for %s", async (_name, args) => {
		const t = setup([]);
		try {
			await t.run(args);
			expect(t.active()).toBe(1);
		} finally {
			t.close();
		}
	});

	it("infers the only running child, and names the candidates otherwise", async () => {
		const one = setup(["kind-1"]);
		const two = setup(["a-1", "b-1"]);
		try {
			await one.run({ op: "on", event: "agent.ended" });
			expect(one.active()).toBe(1);
			await expect(two.run({ op: "on", event: "agent.ended" })).rejects.toThrow(/running: a-1, b-1/);
			expect(two.active()).toBe(0);
		} finally {
			one.close();
			two.close();
		}
	});

	it("answers a job filter with the reason nothing is set", async () => {
		const t = setup([]);
		try {
			const result = await t.run({ op: "on", event: "check.result", filter: { job: "bash-3" } });
			expect(JSON.stringify(result.content)).toMatch(/already notified when bash-3 ends/);
			expect(t.active()).toBe(0);
		} finally {
			t.close();
		}
	});

	it("still refuses a set with no time", async () => {
		const t = setup([]);
		try {
			await expect(t.run({ op: "set" })).rejects.toThrow(/set needs after/);
		} finally {
			t.close();
		}
	});
});
