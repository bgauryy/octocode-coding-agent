import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentDb, DbWriter, openDatabase, providerCooldowns } from "../src/api.ts";
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

describe("providerCooldowns", () => {
	it("keeps one row per provider and the cool-down that ends last, with its pause", () => {
		expect(providerCooldowns.read(agent.db, "anthropic")).toBeUndefined();
		providerCooldowns.record(agent.db, "anthropic", { until: 5_000, pauseMs: 2_000 });
		providerCooldowns.record(agent.db, "openai", { until: 3_000, pauseMs: 0 });
		// A sibling that read the same row and failed a little earlier does not shorten it.
		providerCooldowns.record(agent.db, "anthropic", { until: 4_000, pauseMs: 4_000 });
		expect(providerCooldowns.read(agent.db, "anthropic")).toEqual({ until: 5_000, pauseMs: 2_000 });
		providerCooldowns.record(agent.db, "anthropic", { until: 9_000, pauseMs: 4_000 });
		expect(providerCooldowns.read(agent.db, "anthropic")).toEqual({ until: 9_000, pauseMs: 4_000 });
		expect(providerCooldowns.read(agent.db, "openai")).toEqual({ until: 3_000, pauseMs: 0 });
		const rows = agent.db.prepare("SELECT COUNT(*) AS n FROM provider_cooldowns").get() as { n: number };
		expect(rows.n).toBe(2);
	});

	it("records through the database writer, where another connection reads it", async () => {
		const writer = new DbWriter(locations);
		try {
			await writer.post({
				kind: "provider-cooldown",
				provider: "anthropic",
				cooldown: { until: 7_000, pauseMs: 2_000 },
			});
		} finally {
			writer.close();
		}
		expect(providerCooldowns.read(agent.db, "anthropic")).toEqual({ until: 7_000, pauseMs: 2_000 });
	});

	it("creates its table in a file made without it", () => {
		agent.db.exec("DROP TABLE provider_cooldowns");
		agent.close();
		agent = openDatabase(locations);
		providerCooldowns.record(agent.db, "anthropic", { until: 1, pauseMs: 0 });
		expect(providerCooldowns.read(agent.db, "anthropic")).toEqual({ until: 1, pauseMs: 0 });
	});
});
