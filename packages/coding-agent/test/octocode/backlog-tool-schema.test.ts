import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { entryAccepted, planAccepted, planParameters } from "../../src/octocode/backlog/plan-schema.ts";
import { completionField, undeclaredEntityFields, linkInput } from "../../src/octocode/backlog/tool-schema.ts";

// `backlog` declares the completion (its `done`); `backlogPlan` declares the item fields and no completion.
const declared = { completion: completionField("done: the result") };
const parameters = Type.Object(declared, { additionalProperties: false });
const plan = planParameters("ops");
// What a call may carry: the declaration plus the older forms (a stored-shape completion, a version, link objects).
const validation = Type.Object({ ...declared, ...undeclaredEntityFields }, { additionalProperties: false });
const planValidation = planAccepted(plan);
const completion = {
	summary: "Done",
	files: ["src/a.ts"],
	verification: "Tests passed",
};

describe("backlog entity schema", () => {
	it("declares the light completion on backlog only, and links only in a backlogPlan entry", () => {
		expect(Object.keys(parameters.properties)).not.toContain("links");
		// G2: what a call may carry is declared. An entry names its links; a completion names its retry key.
		const entry = (plan.properties.items as unknown as { items: { properties: Record<string, object> } }).items;
		expect(entry.properties.links).toMatchObject({
			type: "array",
			items: {
				required: ["relation"],
				additionalProperties: false,
				properties: {
					relation: { enum: ["related", "derived_from", "evidence", "output"] },
					target: { type: "string" },
					resource: { type: "object", required: ["resource", "namespace", "id"], additionalProperties: false },
				},
			},
		});
		expect(Value.Check(parameters, { completion: { ...completion, operationKey: "retry-1" } })).toBe(true);
		expect(Value.Check(parameters, { completion })).toBe(true);
		expect(Value.Check(parameters, { completion: { ...completion, lesson: "Reuse X", replaces: 3 } })).toBe(true);
		for (const field of ["links", "completion", "close", "version"])
			expect(Object.keys(plan.properties)).not.toContain(field);
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
		// A `backlogPlan` entry takes the same links in every form, and a version it does not declare.
		expect(Value.Check(entryAccepted, { title: "t", ...link({ target: "src/a.ts" }) })).toBe(true);
		expect(Value.Check(entryAccepted, { id: "B1", version: 3, ...link({ resource }) })).toBe(true);
		expect(Value.Check(entryAccepted, { id: "B1", bogus: 1 })).toBe(false);
		const call = (entry: object) => ({ op: "edit", items: [entry] });
		expect(Value.Check(plan, call({ id: "B1", priority: "p1" }))).toBe(true);
		// The declared forms of a link pass the declaration; the older ones only the looser validation.
		expect(Value.Check(plan, call({ id: "B1", ...link({ target: "src/a.ts" }) }))).toBe(true);
		expect(Value.Check(plan, call({ id: "B1", ...link({ resource }) }))).toBe(true);
		expect(Value.Check(plan, call({ id: "B1", ...link({ target: { resource: "files", path: "a" } }) }))).toBe(false);
		expect(Value.Check(plan, call({ id: "B1", ...link({ target: null, resource }) }))).toBe(false);
		// A call is validated loosely and each entry on its own, so one bad entry is refused on its row.
		expect(Value.Check(planValidation, call({ id: "B1", bogus: 1 }))).toBe(true);
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
