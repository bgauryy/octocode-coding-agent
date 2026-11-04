import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { acceptTargetShorthand, entityFields, linkInput } from "../../src/octocode/backlog/tool-schema.ts";

const parameters = Type.Object(entityFields(false), { additionalProperties: false });
const completion = {
	summary: "Done",
	files: [{ path: "src/a.ts", role: "changed" }],
	verification: { status: "passed", summary: "Tests passed" },
};

describe("backlog entity schema", () => {
	it("types every completion field the store accepts", () => {
		const ok = { ...completion, lesson: "Reuse X", operationKey: "k", replaces: 3 };
		expect(Value.Check(parameters, { completion: ok })).toBe(true);
		expect(Value.Check(parameters, { completion })).toBe(true);
	});

	it.each([
		["a file role outside the enum", { ...completion, files: [{ path: "a", role: "edited" }] }],
		["a file without a path", { ...completion, files: [{ role: "changed" }] }],
		["a verification status outside the enum", { ...completion, verification: { status: "ok", summary: "s" } }],
		["a verification without a summary", { ...completion, verification: { status: "passed" } }],
		["a non-numeric replaces", { ...completion, replaces: "C1" }],
		["an unknown key", { ...completion, notes: "x" }],
	])("refuses %s", (_name, bad) => {
		expect(Value.Check(parameters, { completion: bad })).toBe(false);
	});

	it("declares a link as a string target or a typed resource, and validates a legacy object target", () => {
		const link = (fields: unknown) => ({ links: [{ relation: "evidence", ...(fields as object) }] });
		const resource = { resource: "reports", namespace: "n", id: "r1" };
		expect(Value.Check(parameters, link({ target: "src/a.ts" }))).toBe(true);
		expect(Value.Check(parameters, link({ resource }))).toBe(true);
		expect(Value.Check(parameters, link({ resource: { ...resource, id: undefined } }))).toBe(false);
		expect(Value.Check(parameters, link({ resource: { ...resource, resource: "files" } }))).toBe(false);
		expect(Value.Check(parameters, link({ target: { resource: "files", path: "src/a.ts" } }))).toBe(false);
		const validation = acceptTargetShorthand(parameters);
		expect(Value.Check(validation, link({ target: "src/a.ts" }))).toBe(true);
		expect(Value.Check(validation, link({ target: { resource: "files", path: "src/a.ts" } }))).toBe(true);
		expect(Value.Check(validation, link({ target: null, resource }))).toBe(true);
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

	it("leaves the declared parameters unchanged when building the validation copy", () => {
		const before = JSON.stringify(parameters);
		acceptTargetShorthand(parameters);
		expect(JSON.stringify(parameters)).toBe(before);
	});
});
