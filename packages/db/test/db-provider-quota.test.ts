import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentDb, DbWriter, openDatabase, type ProviderQuota, providerQuota } from "../src/api.ts";
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

const reading = (patch: Partial<ProviderQuota> = {}): ProviderQuota => ({
	provider: "openai",
	window: "primary",
	label: "5h",
	usedFraction: 0.62,
	kind: "plan",
	resetsAt: 9_000,
	source: "header",
	observedAt: 1_000,
	...patch,
});

describe("providerQuota", () => {
	it("keeps one row per provider and window, and the reading taken last", () => {
		expect(providerQuota.listByProvider(agent.db, "openai")).toEqual([]);
		providerQuota.upsert(agent.db, reading());
		providerQuota.upsert(agent.db, reading({ window: "secondary", label: "week", usedFraction: 0.18 }));
		providerQuota.upsert(agent.db, reading({ provider: "anthropic", window: "requests", kind: "rate" }));
		// A peer's older observation, stored late, does not replace the newer one.
		providerQuota.upsert(agent.db, reading({ usedFraction: 0.5, observedAt: 900 }));
		providerQuota.upsert(agent.db, reading({ usedFraction: 0.7, resetsAt: undefined, observedAt: 2_000 }));
		expect(providerQuota.listByProvider(agent.db, "openai")).toEqual([
			reading({ usedFraction: 0.7, resetsAt: undefined, observedAt: 2_000 }),
			reading({ window: "secondary", label: "week", usedFraction: 0.18 }),
		]);
		const rows = agent.db.prepare("SELECT COUNT(*) AS n FROM provider_quota").get() as { n: number };
		expect(rows.n).toBe(3);
	});

	it("lists the readings taken since a time, across providers", () => {
		providerQuota.upsert(agent.db, reading({ observedAt: 500 }));
		providerQuota.upsert(
			agent.db,
			reading({ provider: "anthropic", window: "requests", kind: "rate", observedAt: 1_500 }),
		);
		providerQuota.upsert(
			agent.db,
			reading({ provider: "claude-code", window: "five_hour", source: "event", observedAt: 1_000 }),
		);
		expect(providerQuota.listFresh(agent.db, 1_000).map((row) => `${row.provider}/${row.window}`)).toEqual([
			"anthropic/requests",
			"claude-code/five_hour",
		]);
	});

	it("refuses a kind or source outside the schema", () => {
		expect(() => providerQuota.upsert(agent.db, reading({ kind: "daily" as never }))).toThrow(/CHECK/);
		expect(() => providerQuota.upsert(agent.db, reading({ source: "poll" as never }))).toThrow(/CHECK/);
	});

	it("records through the database writer, where another connection reads it", async () => {
		const writer = new DbWriter(locations);
		try {
			await writer.post({
				kind: "provider-quota",
				readings: [reading(), reading({ window: "secondary", label: "week" })],
			});
		} finally {
			writer.close();
		}
		expect(providerQuota.listByProvider(agent.db, "openai").map((row) => row.window)).toEqual(["primary", "secondary"]);
	});

	it("creates its table in a file made without it", () => {
		agent.db.exec("DROP TABLE provider_quota");
		agent.close();
		agent = openDatabase(locations);
		providerQuota.upsert(agent.db, reading());
		expect(providerQuota.listByProvider(agent.db, "openai")).toEqual([reading()]);
	});
});
