import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAgentDb } from "../../src/config/database.ts";
import type { AgentDb } from "../../../db/src/api.ts";
import { capabilityUsage } from "../../../db/src/api.ts";
import {
	dayBefore,
	daySnapshot,
	localDay,
	USAGE_RETENTION_DAYS,
	UsageRecorder,
	usageScope,
} from "../../src/octocode/capabilities/usage.ts";
import { tmp } from "./helpers.ts";

let db: AgentDb | undefined;
afterEach(() => {
	db?.close();
	db = undefined;
});

const open = () => (db = openAgentDb(path.join(tmp(), "agent.db")));

/** `sessions` sessions on `day`, each calling `tools`. */
function sessionsOn(agent: AgentDb, day: string, sessions: number, tools: readonly string[]) {
	for (let index = 0; index < sessions; index++) {
		const recorder = new UsageRecorder();
		for (const tool of tools) recorder.record(agent, "ws", "main", day, tool);
	}
}

describe("capability usage", () => {
	it("counts a session once and each tool once per session", () => {
		const agent = open();
		const recorder = new UsageRecorder();
		for (const tool of ["a", "b", "a", "a"]) recorder.record(agent, "ws", "main", "2026-11-02", tool);
		recorder.reset();
		recorder.record(agent, "ws", "main", "2026-11-02", "a");
		const days = capabilityUsage.usageBetween(agent.db, "ws", "main", "2026-11-01", "2026-11-03");
		expect(days.get("2026-11-02")).toEqual({ sessions: 2, tools: { a: 2, b: 1 } });
	});

	it("freezes a day's snapshot from the days before it, so later calls that day agree", () => {
		const agent = open();
		sessionsOn(agent, "2026-11-01", 8, ["read"]);
		sessionsOn(agent, "2026-11-02", 2, ["read", "search"]);
		const first = daySnapshot(agent, "ws", "main", "2026-11-03");
		expect(first.sessions).toBe(10);
		// read: 10/10; search: 2/10 reaches the 20% promotion share.
		expect([...first.resident]).toEqual(["read", "search"]);
		// Usage recorded today does not move today's snapshot.
		sessionsOn(agent, "2026-11-03", 20, ["other"]);
		expect([...daySnapshot(agent, "ws", "main", "2026-11-03").resident]).toEqual(["read", "search"]);
	});

	it("keeps yesterday's resident tool while its share stays at 10% or more", () => {
		const agent = open();
		sessionsOn(agent, "2026-11-01", 5, ["read", "search"]);
		expect([...daySnapshot(agent, "ws", "main", "2026-11-02").resident]).toEqual(["read", "search"]);
		// search falls to 5/50 = 10%: kept by hysteresis, though a new tool would need 20%.
		sessionsOn(agent, "2026-11-02", 45, ["read"]);
		expect([...daySnapshot(agent, "ws", "main", "2026-11-03").resident]).toEqual(["read", "search"]);
		// Another workspace or scope keeps its own snapshot.
		expect(daySnapshot(agent, "ws", "reviewer", "2026-11-03").sessions).toBe(0);
	});

	it("drops usage older than the retention window when a snapshot is built", () => {
		const agent = open();
		const today = "2026-11-03";
		const old = dayBefore(today, USAGE_RETENTION_DAYS + 1);
		sessionsOn(agent, old, 1, ["read"]);
		daySnapshot(agent, "ws", "main", today);
		expect(capabilityUsage.usageBetween(agent.db, "ws", "main", old, old).size).toBe(0);
	});

	it("names local days and scopes", () => {
		expect(localDay(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
		expect(dayBefore("2026-03-01", 1)).toBe("2026-02-28");
		expect(usageScope(undefined, false)).toBe("main");
		expect(usageScope("reviewer", true)).toBe("reviewer");
		expect(usageScope(undefined, true)).toBe("general");
	});
});
