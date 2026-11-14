import { describe, expect, it } from "vitest";
import { runnerSpec } from "../../src/octocode/external/runners.ts";

const read = (value: unknown) => runnerSpec("opencode")!.status!.read(JSON.stringify(value), 0);

describe("OpenCode connection status", () => {
	it("checks its own private server environment while ACP keeps its native standalone route", () => {
		const spec = runnerSpec("opencode")!;
		expect(spec.status!.args).toEqual(["auth", "list", "--format", "json", "--standalone"]);
		expect(spec.adapter.args).toEqual(["acp"]);
	});
	it("accepts actual V2 credential and environment connections without inferring billing", () => {
		for (const connection of [
			{ type: "credential", method: "oauth" },
			{ type: "credential", method: "api" },
			{ type: "env" },
		]) {
			expect(read([{ id: "audit", name: "Private provider", connections: [connection] }])).toEqual({
				signedIn: true,
				method: "opencode auth",
			});
		}
	});
	it("reports signed out when provider rows have no connections", () => {
		expect(read([{ id: "opencode", connections: [] }])).toEqual({ signedIn: false });
		expect(
			read([
				{ id: "one", connections: [] },
				{ id: "two", connections: [] },
			]),
		).toEqual({ signedIn: false });
		expect(read([])).toEqual({ signedIn: false });
	});
	it("does not mistake malformed provider metadata for a usable credential", () => {
		for (const value of [
			{ arbitrary: ["metadata"] },
			[{ id: "provider" }],
			[{ id: "provider", connections: [null] }],
			[{ id: "provider", connections: [{}] }],
			[{ id: "provider", connections: [{ type: "unknown" }] }],
		])
			expect(read(value)).toBeUndefined();
	});
	it("keeps direct credential rows from earlier CLI versions compatible", () => {
		expect(read([{ provider: "opencode", type: "api", key: "fixture-secret" }])).toEqual({
			signedIn: true,
			method: "opencode auth",
		});
	});
});
