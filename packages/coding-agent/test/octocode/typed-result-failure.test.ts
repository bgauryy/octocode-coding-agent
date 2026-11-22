import { describe, expect, it } from "vitest";
import { typedResultFailure } from "../../src/octocode/subagents/typed-result.ts";

const valid = { version: 1, schemaHash: "h", status: "valid", data: {} } as const;
const invalid = { version: 1, schemaHash: "h", status: "invalid", error: { code: "schema" } } as const;

describe("typedResultFailure", () => {
	it("is silent without a contract and for a done report with a valid result", () => {
		expect(typedResultFailure(undefined, "partial", undefined)).toBeUndefined();
		expect(typedResultFailure({}, "done", valid)).toBeUndefined();
	});
	it("names a partial report with a valid result as the reason, not 'unavailable'", () => {
		const line = typedResultFailure({}, "partial", valid);
		expect(line).toContain("partial");
		expect(line).not.toContain("unavailable");
	});
	it("names the schema error of a done report that is invalid", () => {
		expect(typedResultFailure({}, "done", invalid)).toBe("Result schema validation: schema.");
	});
	it("says unavailable only when no result exists", () => {
		expect(typedResultFailure({}, "done", undefined)).toBe("Result schema validation: unavailable.");
		expect(typedResultFailure({}, undefined, valid)).toContain("did not report done");
	});
});
