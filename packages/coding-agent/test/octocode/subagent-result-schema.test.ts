import { describe, expect, it } from "vitest";
import {
	admitResultSchema,
	validateResultAnswer,
	validateStoredStructuredResult,
} from "../../src/octocode/subagents/result-schema.ts";
import { ReportTracker } from "../../src/octocode/subagents/report.ts";

const schema = {
	type: "object",
	properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
	required: ["verdict"],
	additionalProperties: false,
};

describe("caller-defined subagent result schema", () => {
	it("captures an immutable schema and validates a full answer before report clipping", () => {
		const source = structuredClone(schema);
		const contract = admitResultSchema(source);
		source.properties.verdict.enum[0] = "changed";
		const answer = `done.\n${"prose ".repeat(1700)}\nStructured result:\n\`\`\`json\n{"verdict":"pass"}\n\`\`\``;
		const tracker = new ReportTracker(undefined, contract);
		tracker.answer(answer, "endTurn", false);
		expect(tracker.result().text.length).toBeLessThan(answer.length);
		expect(tracker.result().structured).toMatchObject({
			version: 1,
			schemaHash: contract.hash,
			status: "valid",
			data: { verdict: "pass" },
		});
	});

	it("rejects unsupported, unsafe, cyclic and oversized schema inputs before launch", () => {
		for (const input of [
			{ type: "object", pattern: "x" },
			{ type: "object", $ref: "https://example.com" },
			{ type: "object", properties: JSON.parse('{"__proto__":{"type":"string"}}') },
			{ type: "object", description: "x".repeat(17_000) },
		])
			expect(() => admitResultSchema(input)).toThrow();
		const cyclic: Record<string, unknown> = { type: "object" };
		cyclic.properties = { self: cyclic };
		expect(() => admitResultSchema(cyclic)).toThrow();
	});

	it("rejects missing, duplicated, trailing, malformed and schema-invalid payload without data", () => {
		const contract = admitResultSchema(schema);
		const good = 'done\nStructured result:\n```json\n{"verdict":"pass"}\n```';
		expect(validateResultAnswer(good, contract).status).toBe("valid");
		for (const bad of [
			"done no block",
			`${good}\nStructured result:\n\`\`\`json\n{}\n\`\`\``,
			`${good}\ntrailing`,
			'done\nStructured result:\n```json\n{"verdict":}\n```',
			'done\nStructured result:\n```json\n{"verdict":"other"}\n```',
		]) {
			const result = validateResultAnswer(bad, contract);
			expect(result.status).toBe("invalid");
			expect(result).not.toHaveProperty("data");
		}
	});

	it("validates persisted versioned metadata without reinterpreting data", () => {
		const contract = admitResultSchema(schema);
		const valid = validateResultAnswer('done\nStructured result:\n```json\n{"verdict":"pass"}\n```', contract);
		expect(validateStoredStructuredResult(valid)).toEqual(valid);
		expect(() => validateStoredStructuredResult({ ...valid, version: 2 })).toThrow();
		expect(() => validateStoredStructuredResult({ ...valid, data: { verdict: "pass", extra: "x" } })).not.toThrow();
		expect(() => validateStoredStructuredResult({ ...valid, data: "x".repeat(100_000) })).toThrow();
	});
});
