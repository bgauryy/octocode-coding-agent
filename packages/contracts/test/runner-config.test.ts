import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { RunnerCommandSchema, RunnerListSchema, type RunnerList } from "../src/config.ts";
import { DAEMON_ROUTES } from "../src/protocol.ts";

const list: RunnerList = {
	tasksEnabled: true,
	runners: [
		{
			id: "claude-code",
			name: "Claude Code",
			cli: { command: "claude", installed: true, version: "2.1.0", tested: "2.1.0" },
			adapter: {
				command: "claude-agent-acp",
				installed: false,
				install: "npm i -g @agentclientprotocol/claude-agent-acp",
			},
			signIn: { state: "signed-in", method: "claude.ai", billing: "plan", checkedAt: 1 },
			login: "claude auth login",
			connected: true,
			enabled: false,
		},
	],
};

describe("runner contract", () => {
	it("has a route under the admin prefix", () => {
		expect(DAEMON_ROUTES.configRunners.startsWith("/api/admin/")).toBe(true);
	});

	it("accepts a list and rejects unknown fields and states", () => {
		expect(Value.Check(RunnerListSchema, list)).toBe(true);
		expect(Value.Check(RunnerListSchema, { ...list, extra: 1 })).toBe(false);
		expect(
			Value.Check(RunnerListSchema, { ...list, runners: [{ ...list.runners[0], signIn: { state: "maybe" } }] }),
		).toBe(false);
	});

	it("accepts only the three commands with a bounded id", () => {
		expect(Value.Check(RunnerCommandSchema, { action: "check", id: "codex" })).toBe(true);
		expect(Value.Check(RunnerCommandSchema, { action: "set-enabled", id: "codex", enabled: true })).toBe(true);
		expect(Value.Check(RunnerCommandSchema, { action: "set-tasks", enabled: false })).toBe(true);
		expect(Value.Check(RunnerCommandSchema, { action: "set-enabled", id: "codex" })).toBe(false);
		expect(Value.Check(RunnerCommandSchema, { action: "check", id: "../x" })).toBe(false);
		expect(Value.Check(RunnerCommandSchema, { action: "run", id: "codex" })).toBe(false);
	});
});
