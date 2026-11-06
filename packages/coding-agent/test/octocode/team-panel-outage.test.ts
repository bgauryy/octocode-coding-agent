import { describe, expect, it } from "vitest";
import { TeamOutage } from "../../src/octocode/team/panel-outage.ts";

describe("TeamOutage: team database failures in the messages list", () => {
	it("says an unusable database at once and once, then its recovery", () => {
		const outage = new TeamOutage();
		expect(outage.next("schema v9 is newer")).toEqual({ text: "Team off: schema v9 is newer", level: "error" });
		expect(outage.next("schema v9 is newer")).toBeUndefined();
		expect(outage.next(undefined)).toEqual({ text: "Team database reachable again.", level: "info" });
		expect(outage.next(undefined)).toBeUndefined();
	});

	it("says nothing for one locked read that succeeds on the next tick", () => {
		const outage = new TeamOutage();
		for (let i = 0; i < 5; i++) {
			expect(outage.next("database is locked", true)).toBeUndefined();
			expect(outage.next(undefined)).toBeUndefined();
		}
	});

	it("says a lock that lasts two ticks once, and a different failure again", () => {
		const outage = new TeamOutage();
		expect(outage.next("database is locked", true)).toBeUndefined();
		expect(outage.next("database is locked", true)).toEqual({
			text: "Team database busy, retrying: database is locked",
			level: "warning",
		});
		for (let i = 0; i < 10; i++) expect(outage.next("database is locked", true)).toBeUndefined();
		expect(outage.next("schema v9 is newer")).toEqual({ text: "Team off: schema v9 is newer", level: "error" });
	});

	it("forgets what it said on reset (a new session says it again)", () => {
		const outage = new TeamOutage();
		outage.next("broken");
		outage.reset();
		expect(outage.next("broken")).toEqual({ text: "Team off: broken", level: "error" });
	});
});
