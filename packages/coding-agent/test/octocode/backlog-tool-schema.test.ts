import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { entityFields, legacyEntityFields, linkInput } from "../../src/octocode/backlog/tool-schema.ts";

const parameters = Type.Object(entityFields(false), { additionalProperties: false });
const subagentParameters = Type.Object(entityFields(true), { additionalProperties: false });
// What a call may carry: the declaration plus the fields older callers still send.
const validation = Type.Object({ ...entityFields(false), ...legacyEntityFields }, { additionalProperties: false });
const completion = {
	summary: "Done",
	files: ["src/a.ts"],
	verification: "Tests passed",
};

describe("backlog entity schema", () => {
	it("declares the light completion and no links, for every role", () => {
		for (const declared of [parameters, subagentParameters]) {
			expect(Object.keys(declared.properties)).not.toContain("links");
			expect(Value.Check(declared, { completion })).toBe(true);
			expect(Value.Check(declared, { completion: { ...completion, lesson: "Reuse X", replaces: 3 } })).toBe(true);
		}
	});

	it.each([
		["a file that is not a path", { ...completion, files: [{ path: "a", role: "changed" }] }],
		["a verification object", { ...completion, verification: { status: "passed", summary: "s" } }],
		["a missing verification", { summary: "Done" }],
		["a non-numeric replaces", { ...completion, replaces: "C1" }],
		["an unknown key", { ...completion, notes: "x" }],
	])("refuses %s in the declared shape", (_name, bad) => {
		expect(Value.Check(parameters, { completion: bad })).toBe(false);
	});

	it("still accepts links and the stored completion shape when validating a call", () => {
		const stored = {
			...completion,
			files: [{ path: "src/a.ts", role: "changed" }],
			verification: { status: "passed", summary: "s" },
		};
		expect(Value.Check(validation, { completion: stored })).toBe(true);
		expect(Value.Check(validation, { completion: { summary: "only" } })).toBe(true);
		const link = (fields: unknown) => ({ links: [{ relation: "evidence", ...(fields as object) }] });
		const resource = { resource: "reports", namespace: "n", id: "r1" };
		expect(Value.Check(validation, link({ target: "src/a.ts" }))).toBe(true);
		expect(Value.Check(validation, link({ resource }))).toBe(true);
		expect(Value.Check(validation, link({ target: { resource: "files", path: "src/a.ts" } }))).toBe(true);
		expect(Value.Check(validation, link({ target: null, resource }))).toBe(true);
		expect(Value.Check(parameters, link({ target: "src/a.ts" }))).toBe(false);
	});

	describe("linkInput", () => {
		const resource = { resource: "memories", namespace: "n", id: "m1" };
		it("maps a string target, a resource and a legacy object target to stored links", () => {
			expect(
				linkInput(
					[
						{ relation: "evidence", target: "./src/a.ts" },
						{ relation: "related", target: "https://example.com/x" },
						{ relation: "related", target: "b7" },
						{ relation: "output", resource, target: null },
						{ relation: "output", target: { resource: "files", path: "src/b.ts" } },
					],
					"repo",
				),
			).toEqual([
				{ relation: "evidence", target: { resource: "files", repositoryKey: "repo", path: "src/a.ts" } },
				{ relation: "related", target: { resource: "external", url: "https://example.com/x" } },
				{ relation: "related", target: { resource: "backlogs", repositoryKey: "repo", id: "B7" } },
				{ relation: "output", target: resource },
				{ relation: "output", target: { resource: "files", repositoryKey: "repo", path: "src/b.ts" } },
			]);
		});

		it("names the link index when both or neither of target and resource are given", () => {
			const ok = { relation: "related" as const, target: "a.md" };
			expect(() => linkInput([ok, { relation: "related", target: "a.md", resource }], "repo")).toThrow(
				/links\[1\] needs exactly one of target .* or resource .*; it has both\./,
			);
			expect(() => linkInput([ok, ok, { relation: "related" }], "repo")).toThrow(
				/links\[2\] needs exactly one of target .*; it has neither\./,
			);
		});
	});
});
