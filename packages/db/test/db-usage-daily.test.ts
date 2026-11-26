import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentDb, DbWriter, openDatabase, type UsageDailyRow, usageDaily } from "../src/api.ts";
import { tmp } from "./helpers.ts";

let agent: AgentDb;
let locations: Parameters<typeof openDatabase>[0];
beforeEach(() => {
	const dir = tmp();
	locations = {
		file: path.join(dir, "agent.db"),
		mirrorFile: path.join(dir, "transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	};
	agent = openDatabase(locations);
});
afterEach(() => agent.close());

const row = (overrides: Partial<UsageDailyRow> = {}): UsageDailyRow => ({
	day: "2026-11-23",
	workspaceId: "w1",
	provider: "anthropic",
	model: "claude-opus-5-5",
	kind: "reply",
	billing: "metered",
	requests: 1,
	input: 100,
	output: 10,
	cacheRead: 50,
	cacheWrite: 5,
	cost: 0.25,
	unpriced: 0,
	...overrides,
});

const count = () => (agent.db.prepare("SELECT COUNT(*) AS n FROM usage_daily").get() as { n: number }).n;

describe("usageDaily", () => {
	it("adds a repeated key into one row and keeps each day, workspace, model, kind and billing apart", () => {
		usageDaily.add(agent.db, [row(), row({ cost: 0.5, input: 200 })]);
		expect(count()).toBe(1);
		usageDaily.add(agent.db, [
			row({ day: "2026-11-22" }),
			row({ workspaceId: "w2" }),
			row({ model: "claude-sonnet-5" }),
			row({ kind: "compaction_attempt" }),
			row({ billing: "plan" }),
		]);
		expect(count()).toBe(6);
		const [opus] = usageDaily
			.totals(agent.db, "2026-11-23", "2026-11-23")
			.filter((total) => total.model === "claude-opus-5-5" && total.billing === "metered");
		// Two workspaces and two kinds of the same model and billing on that day add up; the earlier day does not.
		expect(opus).toEqual({
			provider: "anthropic",
			model: "claude-opus-5-5",
			billing: "metered",
			requests: 4,
			input: 500,
			output: 40,
			cacheRead: 200,
			cacheWrite: 20,
			cost: 1.25,
			unpriced: 0,
		});
	});

	it("totals a day range by provider, model and billing, the costliest first, and names where history starts", () => {
		expect(usageDaily.firstDay(agent.db)).toBeUndefined();
		expect(usageDaily.totals(agent.db, "2026-11-17", "2026-11-23")).toEqual([]);
		usageDaily.add(agent.db, [
			row({ day: "2026-11-16", cost: 9 }),
			row({ day: "2026-11-17", provider: "openai-codex", model: "gpt-6.1", billing: "plan", cost: 3.1 }),
			row({ day: "2026-11-23", cost: 1.24, unpriced: 1 }),
		]);
		expect(usageDaily.firstDay(agent.db)).toBe("2026-11-16");
		const totals = usageDaily.totals(agent.db, "2026-11-17", "2026-11-23");
		expect(totals.map((total) => [total.provider, total.billing, total.cost, total.unpriced])).toEqual([
			["openai-codex", "plan", 3.1, 0],
			["anthropic", "metered", 1.24, 1],
		]);
	});

	it("adds through the database writer, where another connection reads it", async () => {
		const writer = new DbWriter(locations);
		try {
			await writer.post({ kind: "usage-daily", rows: [row(), row({ cost: 0.75 })] });
		} finally {
			writer.close();
		}
		expect(usageDaily.totals(agent.db, "2026-11-23", "2026-11-23")).toMatchObject([{ requests: 2, cost: 1 }]);
	});

	it("refuses a billing other than plan or metered", () => {
		expect(() => usageDaily.add(agent.db, [row({ billing: "free" as never })])).toThrow(/CHECK constraint/);
	});

	it("creates its table when a version-10 file made without it is upgraded", () => {
		agent.db.exec("DROP TABLE usage_daily; PRAGMA user_version=10");
		agent.close();
		agent = openDatabase(locations);
		usageDaily.add(agent.db, [row()]);
		expect(count()).toBe(1);
	});
});
