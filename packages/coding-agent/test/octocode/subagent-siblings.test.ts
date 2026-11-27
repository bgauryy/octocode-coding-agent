import { describe, expect, it } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { identityBlock } from "../../src/octocode/native/prompts/task.ts";
import { configureIdentity } from "../../src/octocode/subagents/run-identity.ts";
import { asSetup } from "./fake-host.ts";

const member = (over: Partial<Member>): Member =>
	({ id: "x", role: "implementer", parentId: "boss", pid: 1, status: "working", ...over }) as Member;

/** Spawns child `kid` of `boss` while `members` run, and returns the identity text it would receive. */
function spawned(members: Member[]): string {
	const run = {
		identity: { id: "kid", role: "implementer", goal: "G", parentId: "boss" },
		profile: undefined,
	} as never;
	const parts = {
		resultContract: undefined,
		linked: undefined,
		skillPlan: { inline: false, roleSkills: [] },
		skillResources: {},
		taskServers: undefined,
		grants: [],
		background: true,
	} as never;
	const permission = { mode: "default", childGrants: () => [] } as never;
	const api = asSetup({ events: { emit() {}, on: () => () => {} } }) as never;
	const runs = { items: new Map(), team: { members: () => members } } as never;
	configureIdentity(run, runs, api, permission, { hasUI: false }, parts);
	return identityBlock((run as { identity: never }).identity);
}

describe("sibling roster in a child's identity", () => {
	it("names a running sibling with its goal and reserved paths", () => {
		const text = spawned([
			member({ id: "briny-reef", goal: "Give a child its roster", locks: ["src/a.ts", "src/dir/"] }),
			member({ id: "other-parent", parentId: "else", goal: "unrelated" }),
			member({ id: "kid", goal: "myself" }),
			member({ id: "done-one", status: "settled" }),
		]);
		expect(text).toContain("briny-reef");
		expect(text).toContain("src/a.ts");
		expect(text).not.toContain("other-parent");
		expect(text).not.toContain("done-one");
		expect(text).not.toContain("myself");
	});

	it("bounds the roster and redacts secrets", () => {
		const many = Array.from({ length: 9 }, (_, i) => member({ id: `sib-${i}`, goal: "g".repeat(300) }));
		const text = spawned(many);
		expect(text).toContain("sib-5");
		expect(text).not.toContain("sib-6");
		expect(text).not.toContain("g".repeat(100));
		expect(spawned([member({ id: "s", goal: "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" })])).not.toContain(
			"abcdefghijklmnop",
		);
	});

	it("adds nothing when there are no siblings", () => {
		expect(spawned([])).toBe(
			identityBlock({ id: "kid", role: "implementer", goal: "G", parentId: "boss", background: undefined }),
		);
	});
});
