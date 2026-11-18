import { describe, expect, it } from "vitest";
import { renameReasoning } from "../../src/octocode/files/tool/queries.ts";

const change = { type: "edit", path: "/work/a.ts", edits: [{ oldText: "a", newText: "b" }] };

/** The corrected call the refusal echoes, read back from its text. */
function echoed(error: unknown): unknown {
	const text = (error as Error).message;
	return JSON.parse(text.slice(text.indexOf("Corrected call:\n") + "Corrected call:\n".length));
}

describe("file tool: refusal for a call with both or neither of queries and patch", () => {
	it("refuses both fields and echoes the corrected call with queries kept and patch dropped", () => {
		let thrown: unknown;
		try {
			renameReasoning({ reason: "Fix a", queries: [{ ...change, reason: "Fix a" }], patch: "*** Begin Patch" });
		} catch (error) {
			thrown = error;
		}
		expect((thrown as Error).message).toMatch(/not both\. Send one\. Corrected call:/);
		expect(echoed(thrown)).toEqual({ reason: "Fix a", queries: [{ ...change, reason: "Fix a" }] });
	});

	it("echoes a change with a path but no type as queries, and names the missing shape", () => {
		let thrown: unknown;
		try {
			renameReasoning({ reason: "Fix a", path: "/work/a.ts" });
		} catch (error) {
			thrown = error;
		}
		expect((thrown as Error).message).toMatch(/had neither\. Wrap the change as queries/);
		expect(echoed(thrown)).toEqual({ reason: "Fix a", queries: [{ path: "/work/a.ts" }] });
	});

	it("reads parameters a model wrote as text inside reason back into the corrected call", () => {
		// The shape a model produced: path and edits as fields, type only as text in `reason`.
		let thrown: unknown;
		try {
			renameReasoning({
				reason: 'Correct the citation.</reason>\n<parameter name="type">edit',
				path: "/work/a.ts",
				edits: [{ oldText: "a", newText: "b" }],
			});
		} catch (error) {
			thrown = error;
		}
		expect((thrown as Error).message).toMatch(/parameters were written as text inside `reason`/);
		expect(echoed(thrown)).toEqual({ reason: "Correct the citation.", queries: [change] });
	});

	it("reads a queries array written as text inside reason", () => {
		let thrown: unknown;
		try {
			renameReasoning({
				reason: `Fix a.</reason>\n<parameter name="queries">${JSON.stringify([change])}`,
			});
		} catch (error) {
			thrown = error;
		}
		expect(echoed(thrown)).toEqual({ reason: "Fix a.", queries: [change] });
	});

	it("still accepts the valid forms", () => {
		expect(() => renameReasoning({ reason: "Fix a", queries: [change] })).not.toThrow();
		expect(() => renameReasoning({ patch: "*** Begin Patch\n*** End Patch" })).not.toThrow();
	});
});
